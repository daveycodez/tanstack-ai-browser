import assert from "node:assert/strict"
import test from "node:test"
import { once } from "node:events"
import { Worker as NodeWorker } from "node:worker_threads"
import { createBehaviorReference } from "./behavior-reference.ts"
import type { BehaviorReferenceRequest } from "./behavior-reference.ts"
import { applyMove, legalMoves, newGame, positionKey } from "../src/lib/checkers.ts"
import type { Board, Game, Side } from "../src/lib/checkers.ts"
import { BEHAVIOR_EVALUATION, chooseBehaviorMove, evaluateBehaviorBoard, evaluateBehaviorPosition } from "./behavior-engine.ts"

function position(ai: string[], human: string[], turn: Side = "ai"): Game {
  const game = newGame("white"), board: Board = Array(64).fill(null)
  for (const [side, names] of [["ai", ai], ["human", human]] as const) for (const name of names) {
    const square = (8 - Number(name[1])) * 8 + name.charCodeAt(0) - 97
    assert.equal(board[square], null)
    board[square] = { side, king: name.endsWith("K") }
  }
  return { ...game, board, initialBoard: board.map(piece => piece ? { ...piece } : null), initialTurn: turn, turn, positions: [positionKey(board, turn)] }
}

test("the conventional reference prefers terminal wins over nonterminal material", () => {
  const game = position(["c3K", "c5", "e1K", "e5K"], ["b4", "b6"])
  const result = evaluateBehaviorPosition(game, { depth: 2 })
  assert.ok(result.bestMoveIds.includes("c3xa5xc7"))
  assert.ok(result.score > BEHAVIOR_EVALUATION.terminal / 2)
  const selected = chooseBehaviorMove(game, { depth: 2 }); assert.ok(selected)
  assert.equal(applyMove(game, selected).status, "ai-won")
})

test("Human minimizes the same AI-centric evaluation and actor regrets stay nonnegative", () => {
  const game = position(["b4", "b6"], ["c3K", "c5", "e1K", "e5K"], "human")
  const result = evaluateBehaviorPosition(game, { depth: 2 })
  assert.ok(result.score < -BEHAVIOR_EVALUATION.terminal / 2)
  assert.equal(applyMove(game, result.bestMoveIds[0]).status, "human-won")
  assert.ok(result.moves.every(move => move.regret >= 0))
  assert.ok(result.moves.filter(move => move.rank === 1).every(move => move.score === result.score))
})

test("capture quiescence sees a compulsory recapture beyond the normal horizon", () => {
  const game = position(["e5", "f8"], ["b4K", "b6", "h2", "h6K", "h8K"])
  const result = evaluateBehaviorPosition(game, { depth: 1 })
  const fatal = result.moves.find(move => move.id === "f8-g7")
  assert.ok(fatal && fatal.score < -BEHAVIOR_EVALUATION.terminal / 2)
  assert.ok(result.quiescenceNodes > 0)
  assert.ok(!result.bestMoveIds.includes("f8-g7"))
})

test("complete compulsory captures are the only scored actions", () => {
  const game = position(["b6"], ["c5", "e3"])
  const legal = legalMoves(game.board, "ai")
  assert.deepEqual(legal.map(move => move.id), ["b6xd4xf2"])
  const result = evaluateBehaviorPosition(game, { depth: 4 })
  assert.deepEqual(result.moves.map(move => move.id), ["b6xd4xf2"])
  assert.equal(chooseBehaviorMove(game), "b6xd4xf2")
})

test("repetition history and the quiet clock affect values instead of being lost in caching", () => {
  const base = position(["a3K"], ["h6K", "h2"])
  const after = applyMove(base, "a3-b4"), key = positionKey(after.board, after.turn)
  const repeat = { ...base, positions: [key, key, positionKey(base.board, base.turn)] }
  const repeated = evaluateBehaviorPosition(repeat, { depth: 1 }).moves.find(move => move.id === "a3-b4")
  const fresh = evaluateBehaviorPosition(base, { depth: 1 }).moves.find(move => move.id === "a3-b4")
  assert.equal(repeated?.score, 0)
  assert.notEqual(fresh?.score, 0)
  assert.equal(applyMove(repeat, "a3-b4").status, "draw")
  const quiet = { ...base, quietMoves: 79 }
  assert.ok(evaluateBehaviorPosition(quiet).moves.every(move => move.score === 0))
  assert.equal(applyMove(quiet, "a3-b4").status, "draw")
})

test("terminal draws and wins never claim a next action", () => {
  const game = position(["a3K"], ["h6K"])
  for (const status of ["draw", "ai-won", "human-won"] as const) {
    const result = evaluateBehaviorPosition({ ...game, status })
    assert.deepEqual(result.moves, [])
    assert.deepEqual(result.bestMoveIds, [])
    assert.equal(chooseBehaviorMove({ ...game, status }), undefined)
    assert.equal(result.score, status === "draw" ? 0 : status === "ai-won" ? BEHAVIOR_EVALUATION.terminal : -BEHAVIOR_EVALUATION.terminal)
  }
})

test("board evaluation is color- and session-independent and includes a king's greater value", () => {
  const game = position(["c5"], ["f4"])
  const regular = evaluateBehaviorBoard(game.board)
  const king = game.board.map(piece => piece ? { ...piece } : null)
  const square = (8 - 5) * 8 + 2
  king[square] = { side: "ai", king: true }
  assert.ok(evaluateBehaviorBoard(king) > regular)
  assert.deepEqual(evaluateBehaviorPosition(game), evaluateBehaviorPosition({ ...game, humanColor: "black", sessionId: "different-game", updatedAt: 0 }))
})

test("same-root scoring and deterministic self-play do not depend on board array identity or UUID", () => {
  const initial = newGame("white"), before = structuredClone(initial)
  assert.deepEqual(evaluateBehaviorPosition(initial, { depth: 2 }), evaluateBehaviorPosition(structuredClone(initial), { depth: 2 }))
  const play = () => {
    let game = structuredClone(initial)
    const moves: string[] = []
    for (let ply = 0; ply < 12 && game.status === "playing"; ply++) {
      const id = chooseBehaviorMove(game, { depth: 4 })
      assert.ok(id)
      moves.push(id)
      game = applyMove(game, id)
    }
    return moves
  }
  assert.deepEqual(play(), play())
  assert.deepEqual(initial, before)
  assert.throws(() => evaluateBehaviorPosition(initial, { depth: 0 }), /depth/)
})


class ReferenceWorker extends EventTarget {
  posted: BehaviorReferenceRequest[] = []
  terminated = 0
  postMessage(request: BehaviorReferenceRequest) { this.posted.push(request) }
  terminate() { this.terminated++ }
  reply(id: number, game: Game, depth: number) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: { id, evaluation: evaluateBehaviorPosition(game, { depth }) } }))
  }
}

test("one CPU worker is reused and response IDs keep concurrent depth requests separate", async () => {
  const game = newGame("black"), worker = new ReferenceWorker()
  let created = 0
  const reference = createBehaviorReference(undefined, () => { created++; return worker })
  const shallow = reference.evaluate(game, { depth: 2 }), primary = reference.evaluate(game, { depth: 4 })
  assert.equal(created, 1)
  assert.equal(worker.posted.length, 2)
  worker.reply(worker.posted[1].id, game, 4)
  worker.reply(worker.posted[0].id, game, 2)
  assert.deepEqual(await shallow, evaluateBehaviorPosition(game, { depth: 2 }))
  assert.deepEqual(await primary, evaluateBehaviorPosition(game, { depth: 4 }))
  reference.dispose()
  assert.equal(worker.terminated, 1)
  await assert.rejects(reference.evaluate(game), { name: "AbortError" })
  assert.equal(created, 1)
})

test("reference cancellation before or during initialization never posts inference", async () => {
  const game = newGame("white"), first = new AbortController()
  first.abort()
  let created = 0
  const pre = createBehaviorReference(first.signal, () => { created++; return new ReferenceWorker() })
  await assert.rejects(pre.evaluate(game), { name: "AbortError" })
  assert.equal(created, 0)
  const controller = new AbortController(), worker = new ReferenceWorker()
  const reference = createBehaviorReference(controller.signal, () => { controller.abort(); return worker })
  await assert.rejects(reference.evaluate(game), { name: "AbortError" })
  assert.equal(worker.posted.length, 0)
  assert.equal(worker.terminated, 1)
})

test("aborting active reference requests rejects them all and discards late replies", async () => {
  const game = newGame("white"), controller = new AbortController(), worker = new ReferenceWorker()
  const reference = createBehaviorReference(controller.signal, () => worker)
  const first = reference.evaluate(game, { depth: 2 }), second = reference.evaluate(game, { depth: 4 })
  controller.abort()
  await assert.rejects(first, { name: "AbortError" })
  await assert.rejects(second, { name: "AbortError" })
  assert.equal(worker.terminated, 1)
  worker.reply(worker.posted[0].id, game, 2)
  await assert.rejects(reference.evaluate(game), { name: "AbortError" })
})

test("a failed reference worker is released instead of reused as valid state", async () => {
  const game = newGame("white"), worker = new ReferenceWorker()
  const reference = createBehaviorReference(undefined, () => worker)
  const pending = reference.evaluate(game)
  worker.dispatchEvent(new Event("error"))
  await assert.rejects(pending, /reference worker failed/)
  assert.equal(worker.terminated, 1)
  await assert.rejects(reference.evaluate(game), /reference worker failed/)
})

test("reference worker payloads retain rule and color history while removing model transcripts", async () => {
  const game = newGame("black"), worker = new ReferenceWorker()
  const played = applyMove(game, legalMoves(game.board, "ai")[0].id)
  const withTranscript = { ...played, history: played.history.map(move => ({ ...move, analysis: { rawAnswer: "old model trace" } as unknown as NonNullable<typeof move.analysis> })) }
  const reference = createBehaviorReference(undefined, () => worker)
  const pending = reference.evaluate(withTranscript)
  assert.deepEqual(worker.posted[0].game.positions, played.positions)
  assert.equal(worker.posted[0].game.quietMoves, played.quietMoves)
  assert.equal(worker.posted[0].game.humanColor, "black")
  assert.equal(worker.posted[0].game.history[0].analysis, undefined)
  worker.reply(worker.posted[0].id, played, 4)
  assert.deepEqual(await pending, evaluateBehaviorPosition(played))
  reference.dispose()
})

test("the real CPU worker matches direct evaluation for both actors and draw history", async () => {
  const url = new URL("./behavior-reference.worker.ts", import.meta.url).href
  const worker = new NodeWorker(`import {parentPort} from 'node:worker_threads';globalThis.postMessage=data=>parentPort.postMessage(data);await import(${JSON.stringify(url)});parentPort.on('message',data=>globalThis.onmessage({data}));`, { eval: true, execArgv: ["--experimental-strip-types"] })
  try {
    const games = [newGame("white"), newGame("black"), { ...position(["a3K"], ["h6K", "h2"]), quietMoves: 79 }]
    for (const [index, game] of games.entries()) {
      const reply = once(worker, "message")
      worker.postMessage({ id: index, game, options: { depth: 4 } })
      const [message] = await reply
      assert.deepEqual(message, { id: index, evaluation: evaluateBehaviorPosition(game) })
    }
  } finally { await worker.terminate() }
})
