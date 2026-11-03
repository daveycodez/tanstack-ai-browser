import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { buildMovePrompt, SHARED_PROMPT_VERSION } from "../../../src/lib/shared-prompt.ts"
import { createGame, legalMoves, sow, applyMove } from "../../../src/lib/mancala.ts"
import { CASES } from "../../cases.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(dir, "../../..")
const sha = raw => createHash("sha256").update(raw).digest("hex")
const json = file => JSON.parse(fs.readFileSync(file, "utf8"))
const rawGzip = file => gunzipSync(fs.readFileSync(file))
const jsonGzip = file => JSON.parse(rawGzip(file).toString("utf8"))
const historical = json(path.join(dir, "frozen-v13-source.json"))
const historicalAliases = {
  "src/lib/shared-prompt.ts": path.join(dir, "source-v13/shared-prompt.ts.txt"),
  "bench/cases.ts": path.join(dir, "source-v13/cases.ts.txt")
}
for (const [file, expected] of Object.entries(historical.sha256))
  assert.equal(sha(fs.readFileSync(historicalAliases[file] ?? path.join(app, file))), expected, `Historical v13 source: ${file}`)
assert.equal(sha(fs.readFileSync(path.join(app, "src/lib/shared-prompt-v13.ts"))), historical.sha256["src/lib/shared-prompt.ts"], "Frozen runtime v13 module")
const current = json(path.join(dir, "frozen-source.json"))
let currentSourceFrozen = false
if (current.promptVersion === SHARED_PROMPT_VERSION) {
  for (const [file, expected] of Object.entries(current.sha256))
    assert.equal(sha(fs.readFileSync(path.join(app, file))), expected, `Current frozen source: ${file}`)
  currentSourceFrozen = true
}

const reportsDir = path.join(dir, "reports")
fs.mkdirSync(reportsDir, { recursive: true })
// Optional explicit capture directory: preserve original bytes, never browser downloads.
if (process.argv[2]) for (const name of fs.readdirSync(process.argv[2]).filter(name => name.endsWith(".json"))) {
  const raw = fs.readFileSync(path.join(process.argv[2], name)), report = JSON.parse(raw.toString("utf8"))
  if (!Array.isArray(report.results) || !report.config || !report.summary) continue
  assert.equal(report.partial, false, `Incomplete capture: ${name}`)
  const target = path.join(reportsDir, `${name}.gz`)
  if (fs.existsSync(target)) assert.deepEqual(rawGzip(target), raw, `Capture changed: ${name}`)
  else fs.writeFileSync(target, gzipSync(raw))
}

function replay(moves, label) {
  let game = { ...createGame(), sessionId: `archived-${label}` }
  let terminalSweep = { human: 0, ai: 0 }
  for (const [index, move] of moves.entries()) {
    const number = move.number ?? move.move
    assert.equal(number, index + 1, `${label}: move number`)
    const side = ["lfm", "LFM3-1.7B-GGUF"].includes(move.player) ? "ai" : "human"
    assert.ok(["human", "lfm", "LFM3-1.7B-GGUF", "GPT-6.1 Sol", "Human", "GPT-6.1 Sol high", "GPT-6.1 Sol (Human)"].includes(move.player), `${label}: player`)
    const pit = side === "ai" ? move.pit + 6 : move.pit - 1
    assert.equal(game.turn, side, `${label}: turn${number}`)
    assert.ok(legalMoves(game.board, side).includes(pit), `${label}: legal${number}`)
    assert.equal(game.board[pit], move.seeds, `${label}: seeds${number}`)
    const next = sow(game.board, side, pit)
    terminalSweep = next.swept
    assert.equal(next.captured, move.captured, `${label}: capture${number}`)
    assert.equal(next.extraTurn, move.extraTurn, `${label}: bonus${number}`)
    if (move.handoff !== undefined) assert.equal(move.handoff, !move.extraTurn, `${label}: handoff${number}`)
    game = applyMove(game, pit)
  }
  return { ...game, terminalSweep }
}
const originalRaw = fs.readFileSync(path.join(dir, "original-game.json")), original = JSON.parse(originalRaw.toString("utf8"))
const originalReview = jsonGzip(path.join(dir, "sol-lfm3-independent-review-2026-11-03.json.gz"))
assert.equal(sha(originalRaw), originalReview.sourceSha256, "Original review source hash")
const originalGame = replay(original.moves, "original")
assert.equal(originalGame.history.length, original.result.totalMoves)
assert.equal(originalGame.board[6], original.result.humanStore)
assert.equal(originalGame.board[13], original.result.opponentStore)
assert.equal(originalGame.status, "human-won")
assert.equal(originalGame.terminalSweep.human, original.result.terminalSweepToHuman)
assert.deepEqual(originalGame.board, originalReview.verified.finalBoard)

let contextReplay
const contextFile = path.join(dir, "context-replay.json.gz")
if (fs.existsSync(contextFile)) {
  const rows = jsonGzip(contextFile)
  for (const row of rows) {
    const position = { ...createGame(), board: row.board.slice(), turn: "ai" }
    const old = buildMovePrompt(position, legalMoves(position.board, "ai"), "shared-v12")
    const v13 = buildMovePrompt(position, legalMoves(position.board, "ai"), "shared-v13")
    assert.deepEqual(row.oldPreferred, old.priorityPits, `Context move${row.move}: old group`)
    assert.deepEqual(row.newPreferred, v13.priorityPits, `Context move${row.move}: v13 group`)
    assert.equal(row.recommendedAction, v13.recommendedAction, `Context move${row.move}: v13 recommendation`)
    assert.deepEqual(row.tieRefinement, v13.tieRefinement, `Context move${row.move}: v13 refinement`)
  }
  contextReplay = { verifiedDecisions: rows.length, changedPreferredGroups: rows.filter(row => JSON.stringify(row.oldPreferred) !== JSON.stringify(row.newPreferred)).map(row => row.move), scope: "Canonical v12/v13 board/order context comparison; no new full-game oracle claim." }
}

const reports = []
let verifiedTrials = 0
for (const name of fs.readdirSync(reportsDir).filter(name => name.endsWith(".json.gz")).sort()) {
  const compressed = fs.readFileSync(path.join(reportsDir, name)), raw = gunzipSync(compressed), report = JSON.parse(raw.toString("utf8"))
  assert.equal(report.partial, false, name)
  assert.ok(["mancala-tactics-v4", "mancala-tactics-v5"].includes(report.suiteVersion), name)
  assert.equal(report.config.sampling, "model defaults", name)
  assert.equal(report.config.opponent.thinking, false, name)
  assert.equal(report.config.reasoningMode, "off", name)
  assert.equal(report.results.length, report.summary.total, name)
  let legalCount = 0, scoredCount = 0, passedCount = 0, followedRecommendation = 0
  for (const row of report.results) {
    const key = `${name}/${row.trial}`, fixture = CASES.find(testCase => testCase.id === row.caseId)
    assert.ok(fixture, `${key}: fixture`)
    assert.deepEqual(row.position.board, fixture.board, `${key}: frozen board`)
    assert.deepEqual(row.expectedPits, fixture.expectedPits, `${key}: accepted actions`)
    assert.deepEqual(row.order.slice().sort((a,b) => a-b), legalMoves(row.position.board, "ai").sort((a,b) => a-b), `${key}: complete legal order`)
    const input = buildMovePrompt(row.position, row.order, report.promptVersion)
    assert.equal(input.systemPrompt, row.input.systemPrompt, `${key}: system`)
    assert.equal(input.prompt, row.input.prompt, `${key}: prompt`)
    assert.deepEqual(input.choices, row.input.choices, `${key}: choices`)
    assert.equal(row.input.version, report.promptVersion, `${key}: version`)
    const answer = JSON.parse(row.rawAnswer), choice = input.choices.find(choice => choice.id === row.pit)
    assert.ok(choice, `${key}: chosen action`)
    assert.deepEqual(Object.keys(answer), ["pit"], `${key}: strict raw output`)
    assert.equal(answer.pit, choice.label, `${key}: raw model answer`)
    if (choice.label === input.recommendedAction) followedRecommendation++
    const legal = legalMoves(row.position.board, "ai").includes(row.pit), passed = row.expectedPits === null ? null : legal && row.expectedPits.includes(row.pit)
    assert.equal(row.legal, legal, `${key}: legality`)
    assert.equal(row.passed, passed, `${key}: grade`)
    if (legal) legalCount++
    if (row.passed !== null) scoredCount++
    if (row.passed === true) passedCount++
    verifiedTrials++
  }
  assert.equal(report.summary.legal, legalCount, name)
  assert.equal(report.summary.scored, scoredCount, name)
  assert.equal(report.summary.passed, passedCount, name)
  reports.push({ file: `reports/${name}`, rawSha256: sha(raw), gzipSha256: sha(compressed), promptVersion: report.promptVersion, suiteVersion: report.suiteVersion, model: report.config.opponent, reasoningMode: report.config.reasoningMode, repetitions: report.config.repetitions, caseIds: report.config.caseIds, partial: report.partial, summary: report.summary, followedRecommendation, misses: report.results.filter(row => row.passed === false).map(row => ({ caseId: row.caseId, repetition: row.repetition, pit: row.pit, expectedPits: row.expectedPits })) })
}

function verifyGames(folder, version) {
  const games = [], gamesDir = path.join(dir, folder)
  if (!fs.existsSync(gamesDir)) return games
  for (const name of fs.readdirSync(gamesDir).filter(name => /^game-[123]\.json\.gz$/.test(name)).sort()) {
    const raw = rawGzip(path.join(gamesDir, name)), log = JSON.parse(raw.toString("utf8"))
    assert.equal(log.promptVersion, version, name)
    assert.equal(log.thinking, false, name)
    assert.equal(log.opponent, "LFM3-1.7B-GGUF", name)
    assert.equal(log.human, "GPT-6.1 Sol high", name)
    const game = replay(log.moves, name)
    assert.notEqual(game.status, "playing", name)
    assert.equal(game.board[6], log.score.human, name)
    assert.equal(game.board[13], log.score.lfm, name)
    assert.equal(log.score.human + log.score.lfm, 48, name)
    const winner = game.status === "ai-won" ? "lfm" : game.status === "human-won" ? "human" : "draw"
    assert.equal(log.winner, winner, name)
    const proof = name.replace(".json.gz", ".jpg")
    assert.ok(fs.existsSync(path.join(gamesDir, proof)), `${name}: proof`)
    games.push({ game: log.game, file: `${folder}/${name}`, rawSha256: sha(raw), proof: `${folder}/${proof}`, proofSha256: sha(fs.readFileSync(path.join(gamesDir, proof))), moves: game.history.length, score: log.score, terminalSweep: game.terminalSweep, winner, legalReplayVerified: true, recordedThinking: false, promptVersion: version, livePromptBytesVerified: false })
  }
  return games
}
const diagnosticGames = verifyGames("v13-diagnostic-games", 13)
const partialFile = path.join(dir, "v13-diagnostic-games/game-2-partial.json.gz")
let partialV13Game
if (fs.existsSync(partialFile)) {
  const raw = rawGzip(partialFile), log = JSON.parse(raw.toString("utf8"))
  assert.equal(log.partial, true)
  assert.equal(log.cancelledForVerifiedContextBug, true)
  assert.equal(log.promptVersion, 13)
  assert.equal(log.thinking, false)
  assert.equal(log.opponent, "LFM3-1.7B-GGUF")
  assert.equal(log.human, "GPT-6.1 Sol high")
  const moves = log.history.map(entry => {
    const lines = entry.split("\n"), actor = lines[1]
    assert.ok(["You", "Opponent"].includes(actor))
    return { number: Number(lines[0]), player: actor === "Opponent" ? "lfm" : "human", pit: Number(/^Pit (\d+)$/.exec(lines[2])?.[1]), seeds: Number(/(\d+) seeds/.exec(lines[3])?.[1]), captured: Number(/captured (\d+)/.exec(lines[3])?.[1] ?? 0), extraTurn: lines.includes("Go again") }
  }).sort((a,b) => a.number - b.number)
  const game = replay(moves, "v13 partial game2")
  assert.equal(game.status, "playing")
  for (const pit of log.pits) {
    const parsed = /^(Opponent’s|Your) pit (\d+), (\d+) seeds$/.exec(pit.label)
    assert.ok(parsed)
    const index = parsed[1] === "Your" ? Number(parsed[2]) - 1 : Number(parsed[2]) + 6
    assert.equal(game.board[index], Number(parsed[3]))
  }
  assert.equal(game.board[6], 15)
  assert.equal(game.board[13], 6)
  assert.equal(game.history.length, 26)
  partialV13Game = { file: "v13-diagnostic-games/game-2-partial.json.gz", rawSha256: sha(raw), partial: true, moves: moves.length, provisionalStores: { human: game.board[6], lfm: game.board[13] }, finalBoardAtStop: game.board, legalReplayVerified: true, finalOutcome: null, livePromptBytesVerified: false }
}
const reviewFile = path.join(dir, "v13-diagnostic-games/game-1-review.json.gz")
let diagnosticReview
if (fs.existsSync(reviewFile)) {
  const review = jsonGzip(reviewFile), game = diagnosticGames.find(game => game.game === 1)
  assert.equal(review.sourceSha256, game.rawSha256)
  for (const [file, expected] of Object.entries(review.sourceHashes)) {
    const relative = file.split("/apps/mancala/")[1]
    if (relative && historical.sha256[relative]) assert.equal(expected, historical.sha256[relative], `Diagnostic review v13 source: ${relative}`)
  }
  assert.equal(sha(fs.readFileSync(path.join(dir, "sol_lfm3_v13_move32_oracle.mjs"))), review.sourceHashes["/private/tmp/sol_lfm3_v13_move32_oracle.mjs"], "Independent unpruned oracle source")
  assert.deepEqual(review.verified.finalBoard, [0,0,0,0,0,0,25,0,0,0,0,0,0,23])
  const move = review.decisions.find(row => row.move === 32)
  assert.deepEqual(move.independentUnprunedOracle.results.map(row => [row.pit,row.finalMargin]), [[7,0],[8,-2],[10,-2]])
  diagnosticReview = { sourceSha256: review.sourceSha256, provedDrawThrownAt: review.summary.verifiedDrawThrownAt, allLegalMove32Margins: move.independentUnprunedOracle.results.map(row => [row.pit,row.finalMargin]) }
}
const freshGames = verifyGames("fresh-games", 14)
let freshGame1Review
const freshReviewFile = path.join(dir, "fresh-games/game-1-review.json.gz")
if (fs.existsSync(freshReviewFile)) {
  const review = jsonGzip(freshReviewFile), first = freshGames.find(game => game.game === 1)
  assert.ok(first)
  assert.equal(review.sourceSha256, first.rawSha256)
  assert.deepEqual(review.verified.finalBoard, [0,0,0,0,0,0,23,0,0,0,0,0,0,25])
  for (const [file, expected] of Object.entries(review.sourceHashes)) {
    const relative = file.split("/apps/mancala/")[1]
    if (relative) assert.equal(sha(fs.readFileSync(path.join(app, relative))), expected, `Fresh game review source: ${relative}`)
  }
  assert.equal(review.summary.lfmDecisions, 20)
  assert.deepEqual(review.summary.sameBoardPreferredSetChanges, [])
  assert.deepEqual(review.summary.sameBoardCanonicalRecommendationChanges, [])
  const human40 = review.allMoves.find(move => move.move === 40)
  const margins = human40.independentTerminalMargins.map(row => [row.pit,row.finalMarginForAI])
  assert.deepEqual(margins, [[0,0],[3,4],[5,2]])
  for (const number of [41,42]) {
    const decision = review.decisions.find(row => row.move === number)
    assert.ok(decision.independentTerminalMargins.every(row => row.complete))
    assert.deepEqual(decision.independentTerminalMargins.filter(row => row.finalMargin > 0).map(row => row.pit), [decision.pit])
  }
  freshGame1Review = { file: "fresh-games/game-1-review.json.gz", sourceSha256: review.sourceSha256, decisions: 20, sameBoardPreferredSetChanges: [], sameBoardCanonicalRecommendationChanges: [], humanMove40MarginsForAI: margins, uniquelyWinningConversions: [41,42], scope: "Independent same-board context reconstruction and terminal judgment; the observed win is not a causal v14-versus-v13 match comparison." }
}
const evidenceScope = "Final UI ledgers replayed against frozen rules and source hashes. Raw live-game prompts, model cache and session presentation orders were not captured."
const freshSeries = { promptVersion: 14, plannedGames: 3, completedGames: freshGames.length, complete: freshGames.length === 3, lfmWins: freshGames.filter(game => game.winner === "lfm").length, targetMet: freshGames.some(game => game.winner === "lfm"), evidenceScope, games: freshGames }
const output = {
  scope: "Raw browser inference reports; every system prompt, position prompt and choice card rebuilt from recorded board/order/version. Source snapshots, legality, accepted actions and totals rechecked.",
  historicalV13SourceVerified: true,
  currentSourceFrozen,
  currentPromptVersion: SHARED_PROMPT_VERSION,
  originalReplay: { sha256: sha(originalRaw), moves: originalGame.history.length, finalBoard: originalGame.board, result: originalGame.status },
  verifiedTrials,
  contextReplay,
  diagnosticV13Series: { stoppedEarly: true, evidenceScope, completedGames: diagnosticGames.length, games: diagnosticGames, partialGame: partialV13Game, independentReview: diagnosticReview },
  freshSeries,
  freshGame1Review,
  reports,
  timingCaveat: "Some reports overlap game play. Model loading, cache state and CPU/GPU contention are uncontrolled; elapsed times are diagnostic, not latency comparisons."
}
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(output, null, 2) + "\n")
console.log(JSON.stringify({ historicalV13SourceVerified: true, currentSourceFrozen, currentPromptVersion: SHARED_PROMPT_VERSION, originalReplayMoves: originalGame.history.length, v13DiagnosticComplete: diagnosticGames.length, v13PartialMoves: partialV13Game?.moves, freshGames: freshGames.length, lfmWins: freshSeries.lfmWins, verifiedTrials, reports: reports.map(report => ({ file: report.file, passed: report.summary.passed, scored: report.summary.scored, legal: report.summary.legal, total: report.summary.total })) }))
