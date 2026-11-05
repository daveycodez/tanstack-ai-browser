import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, legalMoves, newGame, positionKey } from "./checkers.ts"
import type { Board, Game } from "./checkers.ts"
import { attachMoveAnalysis, buildTurnLog, createAiTrace, finishAiTrace, snapshotPosition, traceMatchesPosition } from "./turn-log.ts"

const webgl = { model: "LiquidAI/LFM3-1.7B-GGUF" as const, thinking: false }
const nano = { model: "prompt-api" as const, thinking: true }
function aiTurn() { return applyMove(newGame("white"), legalMoves(newGame("white").board, "human")[0].id) }
function cloneBoard(board: Board) { return board.map(piece => piece ? { ...piece } : null) }

test("new games keep an independent original board and clear prior failures", () => {
  const game = newGame("white")
  assert.deepEqual(game.initialBoard, game.board)
  assert.notEqual(game.initialBoard, game.board)
  assert.equal(game.initialTurn, "human")
  assert.deepEqual(game.aiFailures, [])
  const before = game.initialBoard?.[1]?.king
  if (game.board[1]) game.board[1].king = true
  assert.equal(game.initialBoard?.[1]?.king, before)
})

test("full turn logs replay every move and preserve complete AI prompt facts", () => {
  const before = aiTurn()
  const selected = legalMoves(before.board, "ai")[0].id
  const trace = createAiTrace(before, webgl, "model")
  trace.input = { version: "shared-v1", systemPrompt: "Play a sensible casual game.", prompt: "Board and all legal outcomes.", choices: [{ id: selected, label: "Move man", outcome: "No immediate capture." }] }
  trace.rawAnswer = '{"move":"Move man"}'
  trace.reasoningText = "Visible model notes."
  const finished = finishAiTrace(trace, { moveId: selected })
  let game = attachMoveAnalysis(before, applyMove(before, selected), finished)
  const next = legalMoves(game.board, "human")[0].id
  game = applyMove(game, next)
  const report = buildTurnLog(game)
  assert.equal(report.replay.verified, true)
  assert.equal(report.turns.length, 3)
  assert.deepEqual(report.currentPosition.board, game.board)
  assert.deepEqual(report.turns[0].positionBefore?.board, game.initialBoard)
  assert.deepEqual(report.turns[1].positionBefore?.board, before.board)
  assert.deepEqual(report.turns[1].analysis?.input, finished.input)
  assert.equal(report.turns[1].analysis?.rawAnswer, trace.rawAnswer)
  assert.equal(report.turns[1].analysis?.reasoningText, trace.reasoningText)
  assert.equal(report.turns[1].analysis?.selectedMoveId, selected)
  assert.deepEqual(report.unavailableDiagnosticsPlies, [])
  assert.equal(report.turns[2].positionAfter?.positions.length, game.positions.length)
})

test("logged snapshots contain no nested history or earlier AI analysis trees", () => {
  const before = aiTurn()
  const first = legalMoves(before.board, "ai")[0].id
  const trace = finishAiTrace(createAiTrace(before, webgl, "model"), { moveId: first })
  const after = attachMoveAnalysis(before, applyMove(before, first), trace)
  const snapshot = snapshotPosition(after)
  assert.deepEqual(Object.keys(snapshot).sort(), ["board", "positions", "quietMoves", "status", "turn"])
  assert.equal("history" in snapshot, false)
  assert.equal("analysis" in snapshot, false)
  assert.notEqual(snapshot.board, after.board)
  assert.notEqual(snapshot.positions, after.positions)
  const copied = buildTurnLog(after)
  if (copied.turns[1].analysis) copied.turns[1].analysis.reasoningText = "changed only in exported data"
  assert.equal(after.history[1].analysis?.reasoningText, "")
})

test("forced turns honestly record no inference, prompt, reasoning pass, or output cap", () => {
  const game = aiTurn()
  const trace = finishAiTrace(createAiTrace(game, { ...webgl, thinking: true }, "forced"), { moveId: legalMoves(game.board, "ai")[0].id })
  assert.equal(trace.mode, "forced")
  assert.equal(trace.requestedThinking, true)
  assert.equal(trace.thinking, false)
  assert.equal(trace.reasoningMode, "off")
  assert.equal(trace.reasoningBudgetTokens, null)
  assert.equal(trace.maxOutputTokens, null)
  assert.equal(trace.input, undefined)
  assert.equal(trace.usage, undefined)
  assert.equal(trace.positionBefore.turn, "ai")
})

test("model traces distinguish native reasoning, emulated notes and browser-managed output", () => {
  const game = aiTurn()
  const native = createAiTrace(game, { ...webgl, thinking: true }, "model", { reasoningBudgetTokens: 1024, maxOutputTokens: 8192 })
  assert.equal(native.reasoningMode, "native")
  assert.equal(native.reasoningBudgetTokens, 1024)
  assert.equal(native.maxOutputTokens, 8192)
  const apple = createAiTrace(game, { model: "apple-foundationmodel", thinking: true }, "model")
  assert.equal(apple.reasoningMode, "emulated-working-notes")
  assert.equal(apple.maxOutputTokens, 8192)
  const browser = createAiTrace(game, nano, "model")
  assert.equal(browser.reasoningMode, "emulated-working-notes")
  assert.equal(browser.maxOutputTokens, null)
  assert.equal(browser.reasoningBudgetTokens, 512)
  const off = createAiTrace(game, webgl, "model")
  assert.equal(off.reasoningBudgetTokens, null)
  assert.equal(off.reasoningMode, "off")
  assert.equal(off.sampling, "model defaults")
})

test("mismatched sessions, plies, opponents and selected moves cannot acquire a successful trace", () => {
  const before = aiTurn()
  const moves = legalMoves(before.board, "ai")
  const move = moves[0].id
  const trace = finishAiTrace(createAiTrace(before, webgl, "model"), { moveId: move })
  const after = applyMove(before, move)
  assert.equal(traceMatchesPosition(before, trace, webgl), true)
  assert.equal(traceMatchesPosition(before, { ...trace, sessionId: "restarted" }, webgl), false)
  assert.equal(traceMatchesPosition(before, { ...trace, ply: trace.ply + 1 }, webgl), false)
  assert.equal(traceMatchesPosition(before, trace, nano), false)
  for (const wrong of [{ ...trace, sessionId: "restarted" }, { ...trace, selectedMoveId: moves[1].id }, { ...trace, status: "error" as const }])
    assert.equal(attachMoveAnalysis(before, after, wrong).history.at(-1)?.analysis, undefined)
  assert.equal(attachMoveAnalysis(before, after, trace).history.at(-1)?.analysis?.id, trace.id)
})

test("legacy standard games reconstruct positions but do not invent missing AI prompts", () => {
  const before = aiTurn()
  const game = applyMove(before, legalMoves(before.board, "ai")[0].id)
  delete game.initialBoard
  delete game.initialTurn
  const report = buildTurnLog(game)
  assert.equal(report.replay.source, "legacy standard-start fallback")
  assert.equal(report.replay.verified, true)
  assert.deepEqual(report.unavailableDiagnosticsPlies, [2])
  assert.equal(report.turns[1].analysis, undefined)
  assert.equal(report.turns[1].diagnosticsAvailable, false)
})

test("recorded custom starts replay with their original side while unknown starts stay unavailable", () => {
  const base = newGame("white")
  const board: Board = Array(64).fill(null)
  board[17] = { side: "ai", king: true }
  board[46] = { side: "human", king: true }
  let game: Game = { ...base, board, initialBoard: cloneBoard(board), initialTurn: "ai", turn: "ai", positions: [positionKey(board, "ai")] }
  for (let ply = 0; ply < 2; ply++) game = applyMove(game, legalMoves(game.board, game.turn)[0].id)
  assert.equal(buildTurnLog(game).replay.verified, true)
  delete game.initialBoard
  delete game.initialTurn
  const unknown = buildTurnLog(game)
  assert.equal(unknown.replay.verified, false)
  assert.equal(unknown.initialPosition, undefined)
  assert.equal(unknown.turns[0].positionBefore, undefined)
  assert.equal(unknown.turns[0].positionAfter, undefined)
  assert.ok(unknown.replay.error)
})

test("failed attempts retain real errors and facts without becoming committed moves", () => {
  const game = aiTurn()
  const pending = createAiTrace(game, nano, "model")
  pending.input = { version: "shared-v1", systemPrompt: "system", prompt: "actual position", choices: [] }
  pending.reasoningText = "Working notes before the error."
  const failure = finishAiTrace(pending, { error: new Error("Native schema rejected") })
  game.aiFailures = [failure]
  const report = buildTurnLog(game)
  assert.equal(report.turns.length, 1)
  assert.equal(report.failedAiAttempts.length, 1)
  assert.equal(report.failedAiAttempts[0].error, "Native schema rejected")
  assert.equal(report.failedAiAttempts[0].reasoningText, pending.reasoningText)
  assert.equal(report.failedAiAttempts[0].selectedMoveId, undefined)
  assert.equal(failure.status, "error")
  assert.ok(failure.elapsedMs >= 0)
  assert.ok(failure.finishedAt)
})


test("black-player games replay from the white AI opening with persisted colors", () => {
  let game = newGame("black")
  game = applyMove(game, legalMoves(game.board, "ai")[0].id)
  game = applyMove(game, legalMoves(game.board, "human")[0].id)
  const report = buildTurnLog(game)
  assert.equal(report.humanColor, "black")
  assert.equal(report.opponentColor, "white")
  assert.equal(report.initialPosition?.turn, "ai")
  assert.equal(report.turns[0].side, "ai")
  assert.equal(report.turns[1].side, "human")
  assert.equal(report.replay.verified, true)
})
