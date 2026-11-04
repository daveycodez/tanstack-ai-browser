import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, colorForSide, legalMoves, newGame, positionKey } from "../src/lib/checkers.ts"
import type { Game } from "../src/lib/checkers.ts"
import type { BehaviorTrace, BehaviorTraceMove } from "./behavior-rollouts.ts"
import { createBlindReviewPair, profileBehaviorTrace, summarizeBlindStyleReviews } from "./behavior-style.ts"
import type { BlindStyleReview } from "./behavior-style.ts"

function game(pieces: [number, "human" | "ai", boolean][]): Game {
  const result = newGame("black")
  result.board = Array(64).fill(null)
  for (const [square, side, king] of pieces) result.board[square] = { side, king }
  result.initialBoard = structuredClone(result.board)
  result.positions = [positionKey(result.board, result.turn)]
  return result
}
function trace(initial: Game, ids: string[]): BehaviorTrace {
  let state = initial
  const moves: BehaviorTraceMove[] = []
  for (const moveId of ids) {
    const legal = legalMoves(state.board, state.turn)
    assert.ok(legal.some(move => move.id === moveId), moveId)
    moves.push({ ply: moves.length + 1, side: state.turn, color: colorForSide(state, state.turn), moveId, legalChoices: legal.length,
      source: "model", inferred: state.turn === "ai", quietReversal: false, referenceRegret: 0, referenceScore: 0, referenceRank: 1 })
    state = applyMove(state, moveId)
  }
  return { id: "secret-model", mode: "model", seed: "secret-seed", humanColor: "black", initialTurn: initial.turn,
    maxPlies: ids.length, moves, status: "capped", finalGame: state, inferredAiTurns: 0, forcedAiTurns: 0, quietReversals: { ai: 0, human: 0 } }
}
const shuffling = () => trace(game([[17, "ai", true], [46, "human", true]]), ["b6-c5", "g3-f4", "c5-b6", "f4-g3", "b6-c5"])

test("style detects actual quiet reversals and repeated boards without labelling them bad plans", () => {
  const profile = profileBehaviorTrace(shuffling())
  assert.equal(profile.decisions, 3)
  assert.equal(profile.repetition.quietReversals, 2)
  assert.equal(profile.repetition.repeatedPositions, 1)
  assert.equal(profile.continuity.samePieceFollowThrough, 2)
  assert.equal(profile.continuity.samePieceRate, 100)
  assert.equal(profile.activity.kingApproaches, 2)
  assert.match(profile.interpretation, /not a validated/)
  assert.ok(!("humanScore" in profile))
})

test("independent severity remains separate from style and excludes forced choices", () => {
  const profile = profileBehaviorTrace(shuffling(), { qualitySource: "external-checkers-engine", quality: [{ ply: 1, regret: 0 }, { ply: 3, regret: 60 }, { ply: 5, regret: 130 }] })
  assert.equal(profile.quality.source, "external-checkers-engine")
  assert.equal(profile.quality.acceptable, 1)
  assert.equal(profile.quality.costly, 1)
  assert.equal(profile.quality.severe, 1)
  assert.equal(profile.quality.worstRegret, 130)
  const forced = profileBehaviorTrace(trace(game([[17, "ai", false], [26, "human", false], [55, "human", false]]), ["b6xd4"]), { quality: [{ ply: 1, regret: 500 }] })
  assert.equal(forced.forced, 1)
  assert.equal(forced.decisions, 0)
  assert.equal(forced.quality.scored, 0)
  assert.equal(forced.quality.acceptableRate, null)
})

test("missing reference scores stay unscored and terminal mistakes are severe despite a small numerical regret", () => {
  const missing = shuffling()
  const unknown = profileBehaviorTrace({ ...missing, moves: missing.moves.map(({ ply, side, moveId }) => ({ ply, side, moveId })) })
  assert.equal(unknown.quality.scored, 0)
  assert.equal(unknown.quality.unscored, 3)
  assert.equal(unknown.quality.meanRegret, null)
  assert.equal(unknown.quality.acceptableRate, null)
  const profile = profileBehaviorTrace(shuffling(), { quality: [{ ply: 1, regret: 0, terminalBlunder: true }] })
  assert.equal(profile.quality.severe, 1)
  assert.equal(profile.quality.acceptable, 0)
  assert.equal(profile.quality.costly, 0)
  assert.equal(profile.quality.unscored, 2)
  assert.throws(() => profileBehaviorTrace(shuffling(), { acceptableRegret: 100, severeRegret: 25 }))
})

test("blind cards remove policy identities, timings, scores and model metadata while retaining replayable colors", () => {
  const sample = shuffling(), pair = createBlindReviewPair({ id: "pair-1", a: { label: "LFM3", trace: sample }, b: { label: "Cake", trace: sample }, salt: "private" })
  assert.deepEqual(pair, createBlindReviewPair({ id: "pair-1", a: { label: "LFM3", trace: sample }, b: { label: "Cake", trace: sample }, salt: "private" }))
  const payload = JSON.stringify(pair.public)
  for (const secret of ["LFM3", "Cake", "secret-model", "secret-seed", "referenceRegret", "finalGame", "inferred"]) assert.ok(!payload.includes(secret), secret)
  assert.equal(pair.public.A.opponentColor, "white")
  assert.equal(pair.public.A.moves[0].move, "b6-c5")
  assert.deepEqual([pair.privateKey.A, pair.privateKey.B].sort(), ["Cake", "LFM3"])
  assert.throws(() => createBlindReviewPair({ id: "failed", a: { label: "LFM3", trace: { ...sample, status: "error" } }, b: { label: "Cake", trace: sample }, salt: "private" }))
})

test("human ratings decode counterbalanced identities and reject duplicate or invalid ratings", () => {
  const high = { coherentPlans: 5, plausibleChoices: 5, interestingVariety: 5, avoidsAimlessRepetition: 5 }, low = { coherentPlans: 1, plausibleChoices: 1, interestingVariety: 1, avoidsAimlessRepetition: 1 }
  const base: BlindStyleReview = { pairId: "one", reviewerId: "rater", A: high, B: low, preferred: "A", expertise: "casual", confidence: "medium", strengthComparable: "uncertain" }
  const second: BlindStyleReview = { ...base, pairId: "two", A: low, B: high, preferred: "B", strengthComparable: "yes" }
  const keys = [{ pairId: "one", A: "LFM3", B: "Cake" }, { pairId: "two", A: "Cake", B: "LFM3" }]
  const result = summarizeBlindStyleReviews([base, second], keys)
  assert.equal(result.opponents.LFM3.preferences, 2)
  assert.equal(result.opponents.LFM3.mean.plausibleChoices, 5)
  assert.equal(result.opponents.Cake.mean.coherentPlans, 1)
  assert.equal(result.uniqueReviewers, 1)
  assert.equal(result.comparableStrengthRatings, 1)
  assert.throws(() => summarizeBlindStyleReviews([base, base], keys))
  assert.throws(() => summarizeBlindStyleReviews([{ ...base, A: { ...high, coherentPlans: 6 } }], keys))
  assert.throws(() => summarizeBlindStyleReviews([base], []))
  assert.equal(summarizeBlindStyleReviews([], []).ratings, 0)
})
