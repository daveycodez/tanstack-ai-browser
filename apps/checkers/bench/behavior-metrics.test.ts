import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, legalMoves, newGame, positionKey } from "../src/lib/checkers.ts"
import type { Game } from "../src/lib/checkers.ts"
import { BEHAVIOR_ENGINE_VERSION } from "./behavior-engine.ts"
import type { BehaviorEvaluation } from "./behavior-engine.ts"
import { successorStateKey, summarizeBehavior } from "./behavior-metrics.ts"
import type { BehaviorObservation, BehaviorPosition } from "./behavior-metrics.ts"

function reference(game: Game, depth: number, regrets: readonly number[]): BehaviorEvaluation {
  const legal = legalMoves(game.board, game.turn)
  const best = Math.min(...regrets)
  return { evaluationVersion: BEHAVIOR_ENGINE_VERSION, depth, side: game.turn, score: 0,
    moves: legal.map((move, index) => ({ id: move.id, score: -(regrets[index] ?? 100), regret: regrets[index] ?? 100, rank: (regrets[index] ?? 100) === best ? 1 : 2 })),
    bestMoveIds: legal.filter((_, index) => regrets[index] === best).map(move => move.id), nodes: 1, leafNodes: 1, quiescenceNodes: 0 }
}
function position(id = "choice"): BehaviorPosition {
  const game = newGame("black"), scores = reference(game, 4, [0, 0])
  return { id, stratum: "free", game, reference2: { ...scores, depth: 2 }, reference4: scores,
    recommendedIds: [scores.moves[0].id], unsafeMoveIds: [] }
}
function sample(position: BehaviorPosition, index: number, moveId: string | undefined, extra: Partial<BehaviorObservation> = {}): BehaviorObservation {
  return { positionId: position.id, repetition: index, condition: "fixed", legal: moveId !== undefined, moveId,
    ...(moveId && { successorKey: successorStateKey(applyMove(position.game, moveId)) }), inputHash: "same-request", ...extra }
}
const close = (actual: number | null, expected: number) => { assert.ok(actual !== null); assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`) }

test("a fixed acceptable alternative is deterministic even when it disagrees with the canonical engine move", () => {
  const p = position(), id = p.reference4.moves[1].id
  const observations = Array.from({ length: 8 }, (_, index) => sample(p, index, id))
  const report = summarizeBehavior(observations, [p], { passed: 4, total: 4 })
  close(report.conditions.fixed.repeatability, 100)
  close(report.conditions.fixed.safeVariety, 0)
  close(report.conditions.fixed.referenceAcceptableRate, 100)
  close(report.conditions.fixed.engineAnyBestAgreement, 100)
  close(report.conditions.fixed.engineCanonicalAgreement, 0)
  close(report.conditions.fixed.acceptableOutsidePolicyRate, 100)
  close(report.skillScore, 100)
})

test("balanced safe alternatives earn variety independently of tactical skill", () => {
  const p = position(), observations = Array.from({ length: 8 }, (_, index) => sample(p, index, p.reference4.moves[index % 2].id))
  const report = summarizeBehavior(observations, [p], { passed: 1, total: 4 })
  close(report.conditions.fixed.safeVariety, 100)
  close(report.conditions.fixed.repeatability, 100 * 24 / 56)
  close(report.skillScore, 50)
  assert.equal(report.tacticalSuccessRate, 25)
  assert.deepEqual(report, summarizeBehavior(observations, [p], { passed: 1, total: 4 }))
  assert.ok(report.conditions.fixed.confidence95.safeVariety)
})

test("random bad decisions and failed responses do not earn safe-variety or skill credit", () => {
  const p = position(), ids = p.reference4.moves.slice(2).map(move => move.id)
  const bad = Array.from({ length: 8 }, (_, index) => sample(p, index, ids[index % ids.length]))
  const report = summarizeBehavior(bad, [p], { passed: 4, total: 4 })
  close(report.conditions.fixed.safeVariety, 0)
  close(report.referenceAcceptableRate, 0)
  close(report.skillScore, 0)
  const errors = Array.from({ length: 4 }, (_, index) => sample(p, index, undefined, { error: "generation failed" }))
  const failed = summarizeBehavior(errors, [p], { passed: 4, total: 4 })
  assert.equal(failed.conditions.fixed.repeatability, null)
  close(failed.conditions.fixed.safeVariety, 0)
  assert.equal(failed.conditions.fixed.errors, 4)
  close(failed.skillScore, 0)
})

test("failures remain in the quality denominator and reduce otherwise balanced safe variety", () => {
  const p = position(), observations = Array.from({ length: 8 }, (_, index) => sample(p, index, p.reference4.moves[index % 2].id))
  observations.push(...Array.from({ length: 8 }, (_, index) => sample(p, index + 8, undefined, { error: "stopped" })))
  const report = summarizeBehavior(observations, [p], { passed: 4, total: 4 })
  close(report.referenceAcceptableRate, 50)
  close(report.conditions.fixed.safeVariety, 50)
  close(report.skillScore, Math.sqrt(5000))
  close(report.conditions.fixed.engineAnyBestAgreement, 50)
})

test("order-following variety is exposed separately from fixed-input behavior", () => {
  const p = position(), ids = p.reference4.moves.slice(0, 2).map(move => move.id)
  const fixed = Array.from({ length: 8 }, (_, index) => sample(p, index, ids[0], { firstCardId: ids[0], firstRecommendedId: ids[0] }))
  const seeded = Array.from({ length: 8 }, (_, index) => sample(p, index, ids[index % 2], { condition: "game-seeded", firstCardId: ids[index % 2], inputHash: `seed-${index}` }))
  const report = summarizeBehavior([...fixed, ...seeded], [p], { passed: 4, total: 4 })
  close(report.conditions.fixed.safeVariety, 0)
  close(report.conditions["game-seeded"].safeVariety, 100)
  close(report.conditions["game-seeded"].firstCardRate, 100)
  assert.equal(report.conditions.fixed.fixedInputPositionsChanged, 0)
  const changed = summarizeBehavior([...fixed, sample(p, 9, ids[0], { inputHash: "different" })], [p], { passed: 4, total: 4 })
  assert.equal(changed.conditions.fixed.fixedInputPositionsChanged, 1)
})

test("forced and unique-acceptable tactical decisions do not inflate free-choice variety", () => {
  const free = position(), tactical = { ...position("tactic"), stratum: "tactical" as const }, forced = { ...position("forced"), stratum: "forced" as const }
  const observations = [free, tactical, forced].flatMap(p => Array.from({ length: 4 }, (_, index) => sample(p, index, p.reference4.moves[index % 2].id)))
  const report = summarizeBehavior(observations, [free, tactical, forced], { passed: 4, total: 4 })
  assert.equal(report.conditions.fixed.attempts, 8)
  assert.equal(report.conditions.fixed.forcedObservations, 4)
  assert.equal(report.conditions.fixed.freeChoicePositions, 1)
  close(report.conditions.fixed.safeVariety, 100)
})

test("two complete jump paths reaching the same successor are one strategic outcome", () => {
  const game = newGame("black")
  game.board = Array(64).fill(null)
  game.board[35] = { side: "ai", king: true } // d4
  for (const square of [26, 10, 12, 28, 55]) game.board[square] = { side: "human", king: false }
  game.positions = [positionKey(game.board, "ai")]
  const moves = legalMoves(game.board, "ai")
  assert.equal(moves.length, 2)
  assert.equal(successorStateKey(applyMove(game, moves[0].id)), successorStateKey(applyMove(game, moves[1].id)))
  const ref = reference(game, 4, [0, 0]), p = { ...position(), game, reference2: { ...ref, depth: 2 }, reference4: ref }
  const report = summarizeBehavior(Array.from({ length: 8 }, (_, index) => sample(p, index, moves[index % 2].id)), [p], { passed: 4, total: 4 })
  assert.equal(report.conditions.fixed.freeChoicePositions, 0)
  assert.equal(report.conditions.fixed.safeVariety, null)
  close(report.conditions.fixed.repeatability, 100)
})

test("successor equivalence preserves quiet-clock, repetition-count and terminal distinctions", () => {
  const game = newGame("black"), key = successorStateKey(game)
  assert.notEqual(key, successorStateKey({ ...game, quietMoves: game.quietMoves + 1 }))
  assert.notEqual(key, successorStateKey({ ...game, positions: [...game.positions, game.positions[0]] }))
  assert.notEqual(key, successorStateKey({ ...game, status: "draw" }))
  const other = positionKey(applyMove(game, legalMoves(game.board, "ai")[0].id).board, "human")
  assert.equal(successorStateKey({ ...game, positions: [other, ...game.positions] }), successorStateKey({ ...game, positions: [...game.positions, other] }))
})

test("reference depth, tolerance and immediate-loss safety are explicit sensitivities", () => {
  const p = position(), legal = p.reference4.moves
  p.reference4 = reference(p.game, 4, [0, 30])
  p.reference2 = reference(p.game, 2, [30, 0])
  const report = summarizeBehavior([sample(p, 0, legal[1].id), sample(p, 1, legal[1].id)], [p], { passed: 1, total: 1 })
  close(report.referenceAcceptableRate, 0)
  close(report.sensitivity.depth4[2].conditions.fixed.referenceAcceptableRate, 100)
  close(report.sensitivity.depth2[0].conditions.fixed.referenceAcceptableRate, 100)
  p.unsafeMoveIds = [legal[1].id]
  const unsafe = summarizeBehavior([sample(p, 0, legal[1].id)], [p], { passed: 1, total: 1 })
  close(unsafe.sensitivity.depth4[2].conditions.fixed.referenceAcceptableRate, 0)
})

test("invalid observation metadata cannot fabricate variety and inputs stay unchanged", () => {
  const p = position(), observation = sample(p, 0, p.reference4.moves[0].id)
  const snapshot = JSON.stringify({ p, observation })
  summarizeBehavior([observation], [p], { passed: 1, total: 1 })
  assert.equal(JSON.stringify({ p, observation }), snapshot)
  assert.throws(() => summarizeBehavior([{ ...observation, successorKey: "invented" }], [p], { passed: 1, total: 1 }), /Successor mismatch/)
  assert.throws(() => summarizeBehavior([{ ...observation, positionId: "unknown" }], [p], { passed: 1, total: 1 }), /unknown behavior position/)
  assert.throws(() => summarizeBehavior([observation], [p, p], { passed: 1, total: 1 }), /unique/)
  assert.throws(() => summarizeBehavior([observation], [p], { passed: 2, total: 1 }), /Invalid tactical/)
})
