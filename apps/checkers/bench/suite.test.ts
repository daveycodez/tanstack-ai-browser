import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, legalMoves } from "../src/lib/checkers.ts"
import { CASES, gameForCase, SUITE_VERSION } from "./cases.ts"
import { acceptedChoices, auditCase, auditSuite, inspectChoices } from "./audit.ts"

const find = (id: string) => {
  const fixture = CASES.find(item => item.id === id)
  assert.ok(fixture, `Missing fixture ${id}`)
  return fixture
}

test("the frozen checkers suite independently audits every accepted set and separates holdouts", () => {
  const observations = auditSuite(CASES)
  assert.equal(SUITE_VERSION, "checkers-audited-v7")
  assert.equal(observations.length, 39)
  assert.equal(observations.filter(item => item.partition === "calibration").length, 33)
  assert.equal(observations.filter(item => item.partition === "holdout").length, 6)
  assert.equal(observations.filter(item => item.expectedMoveIds !== null).length, 29)
  assert.equal(observations.filter(item => item.expectedMoveIds === null).length, 10)
  assert.equal(observations.filter(item => item.legalMoveIds.length === 1).length, 1)
})

test("the audit rejects a favorite move when an objective has multiple valid ties", () => {
  const fixture = find("recapture-compensation")
  assert.deepEqual(new Set(auditCase(fixture).expectedMoveIds), new Set(["e3xg5", "d2xb4"]))
  assert.throws(() => auditCase({ ...fixture, expectedMoveIds: ["e3xg5"] }), /declared expectation/)
  assert.throws(() => auditCase({ ...fixture, expectedMoveIds: ["not-a-move"] }), /declared expectation/)
})

test("the mechanical capture diagnostic is a single complete chain without an AI decision grade", () => {
  const fixture = find("forced-full-chain")
  const game = gameForCase(fixture)
  const moves = legalMoves(game.board, "ai")
  assert.equal(moves.length, 1)
  assert.equal(moves[0].id, "b6xd4xf2")
  assert.equal(moves[0].captures.length, 2)
  assert.throws(() => applyMove(game, "b6xd4"), /Illegal move/)
  assert.equal(fixture.expectedMoveIds, null)
})

test("draw objectives replay real legal repetitions rather than injecting repetition counters", () => {
  for (const id of ["avoid-third-repeat-ahead", "take-third-repeat-behind"]) {
    const fixture = find(id)
    const game = gameForCase(fixture)
    assert.equal(game.history.length, 7)
    assert.equal(game.positions.length, 8)
    assert.equal(game.status, "playing")
    assert.equal(applyMove(game, "a3-b4").status, "draw")
  }
  assert.deepEqual(acceptedChoices(gameForCase(find("avoid-third-repeat-ahead")), "avoid-draw-ahead"), ["a7-b6", "a3-b2"])
  assert.deepEqual(acceptedChoices(gameForCase(find("take-third-repeat-behind")), "take-draw-behind"), ["a3-b4"])
})

test("forced following-turn wins are checked against every legal Red reply", () => {
  const game = gameForCase(find("force-next-turn-win-alternative"))
  const choices = inspectChoices(game)
  const forced = choices.filter(choice => choice.forcesWin)
  assert.ok(forced.length > 0 && forced.length < choices.length)
  assert.ok(forced.some(choice => choice.replies.length >= 2))
  assert.ok(forced.every(choice => choice.replies.every(reply => reply.status === "playing" && reply.aiWins.length > 0)))
  assert.ok(choices.filter(choice => !choice.forcesWin).every(choice => choice.replies.some(reply => reply.status !== "playing" || reply.aiWins.length === 0)))
})

test("promotion risk concerns other pieces, since a newly crowned edge king cannot itself be jumped", () => {
  const game = gameForCase(find("promotion-not-at-any-cost"))
  const choices = inspectChoices(game)
  assert.ok(choices.some(choice => choice.promotes && choice.worstNet < 0))
  assert.ok(choices.filter(choice => choice.promotes).every(choice => !choice.newKingTaken))
  assert.deepEqual(acceptedChoices(game, "safe-promotion", choices), ["d2-c1"])
})

test("fixture validation rejects light squares, duplicate pieces, uncrowned promotion-row men and one-move grades", () => {
  const fixture = find("safe-crowning")
  assert.throws(() => gameForCase({ ...fixture, setup: { black: ["a8"], red: ["b2"] } }), /dark square/)
  assert.throws(() => gameForCase({ ...fixture, setup: { black: ["b6"], red: ["b6"] } }), /Duplicate/)
  assert.throws(() => auditCase({ ...fixture, setup: { black: ["b8", "b2"], red: ["b8"] } }), /Duplicate/)
  assert.throws(() => auditCase({ ...fixture, setup: { black: ["b8", "a1"], red: ["b2"] } }), /uncrowned/)
  assert.throws(() => auditCase({ ...find("forced-full-chain"), objective: "win-now", expectedMoveIds: ["b6xd4xf2"] }), /scored fixture/)
})


test("the promotion-denial tradeoff stays ungraded when a larger capture has the better checked return", () => {
  const fixture = find("deny-red-promotion-alternative")
  assert.equal(fixture.objective, "diagnostic")
  assert.equal(fixture.expectedMoveIds, null)
  assert.deepEqual(fixture.signalMoveIds, ["d8xf6"])
  const choices = inspectChoices(gameForCase(fixture))
  const deny = choices.find(choice => choice.id === "d8xf6")
  const capture = choices.find(choice => choice.id === "d8xb6xd4")
  assert.ok(deny && capture)
  assert.equal(deny.permitsPromotion, false)
  assert.equal(deny.worstNet, 1)
  assert.equal(capture.permitsPromotion, true)
  assert.equal(capture.capturedValue, 3)
  assert.equal(capture.worstNet, 2)
  assert.equal(capture.humanWins, false)
  assert.equal(auditCase(fixture).expectedMoveIds, null)
})

test("cache replay uses real non-forced turns, independent snapshots, and honest counters", async () => {
  const {cacheReplayPositions,cacheMetrics}=await import("./cache-replay-positions.ts")
  const {positions,skippedForcedPlies}=cacheReplayPositions()
  assert.equal(positions.length,7)
  assert.deepEqual(positions.map(game=>game.history.length),[1,3,5,9,13,19,21])
  assert.deepEqual(skippedForcedPlies,[7,11,15,17])
  assert.equal(new Set(positions.map(game=>game.sessionId)).size,1)
  for(const game of positions){assert.equal(game.turn,"ai");assert.ok(legalMoves(game.board,"ai").length>1)}
  positions[0].board.fill(null)
  assert.ok(cacheReplayPositions().positions[0].board.some(Boolean))
  assert.equal(cacheMetrics(undefined,1,"prompt-api").cachedInputTokens,null)
  assert.equal(cacheMetrics({promptTokens:10,completionTokens:1,totalTokens:11},1,"prompt-api").cachedInputTokens,null)
  assert.equal(cacheMetrics({promptTokens:10,completionTokens:1,totalTokens:11},1,"LiquidAI/LFM3-1.7B-GGUF").cachedInputTokens,0)
})
