import { applyMove, positionKey } from "../src/lib/checkers.ts"
import type { Game } from "../src/lib/checkers.ts"
import type { BehaviorEvaluation } from "./behavior-engine.ts"

export const BEHAVIOR_METRICS_VERSION = "safe-variety-and-skill-v1"
export const REFERENCE_TOLERANCE = 25
export type BehaviorCondition = "fixed" | "game-seeded"
export type BehaviorPosition = {
  id: string
  stratum: "free" | "tactical" | "forced"
  game: Game
  reference2: BehaviorEvaluation
  reference4: BehaviorEvaluation
  recommendedIds: string[]
  unsafeMoveIds: string[]
}
export type BehaviorObservation = {
  positionId: string
  condition: BehaviorCondition
  repetition: number
  moveId?: string
  legal: boolean
  successorKey?: string
  inputHash?: string
  firstCardId?: string
  firstRecommendedId?: string
  error?: string
}
export type BehaviorConditionMetrics = {
  attempts: number
  legalResponses: number
  errors: number
  forcedObservations: number
  positionCount: number
  freeChoicePositions: number
  recommendationSingletonPositions: number
  repeatability: number | null
  freeChoiceRepeatability: number | null
  safeVariety: number | null
  referenceAcceptableRate: number | null
  meanRegret: number | null
  medianRegret: number | null
  worstRegret: number | null
  engineAnyBestAgreement: number | null
  engineCanonicalAgreement: number | null
  policyAdherence: number | null
  acceptableOutsidePolicyRate: number | null
  firstCardRate: number | null
  firstRecommendedRate: number | null
  fixedInputPositionsChecked: number
  fixedInputPositionsChanged: number
  confidence95: { repeatability: [number, number] | null; safeVariety: [number, number] | null }
}
type PreparedObservation = {
  valid: boolean; acceptable: boolean; key?: string; regret?: number
  anyBest: boolean; canonicalBest: boolean; policy: boolean
  hasFirstCard: boolean; firstCard: boolean; hasFirstRecommended: boolean; firstRecommended: boolean
}
type PreparedPosition = { position: BehaviorPosition; observations: PreparedObservation[]; acceptableStateCount: number }
const average = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const rate = (count: number, total: number) => total ? 100 * count / total : null
const median = (values: readonly number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), index = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2
}

/** Rule-relevant successor equivalence; jump-path spelling does not add strategic variety. */
export function successorStateKey(gameAfter: Game): string {
  const counts = new Map<string, number>()
  for (const key of gameAfter.positions) counts.set(key, (counts.get(key) ?? 0) + 1)
  return JSON.stringify([positionKey(gameAfter.board, gameAfter.turn), gameAfter.status, gameAfter.quietMoves,
    [...counts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])
}
function pairwiseRepeatability(observations: readonly PreparedObservation[]): number | null {
  const valid = observations.filter(observation => observation.valid && observation.key !== undefined)
  if (valid.length < 2) return null
  const counts = new Map<string, number>()
  for (const observation of valid) {
    const key = observation.key
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return 100 * [...counts.values()].reduce((sum, count) => sum + count * (count - 1), 0) / (valid.length * (valid.length - 1))
}
function safeVariety(group: PreparedPosition): number | null {
  if (group.position.stratum !== "free" || group.acceptableStateCount < 2 || group.observations.length < 2) return null
  const acceptable = group.observations.filter(observation => observation.acceptable)
  if (acceptable.length < 2) return 0
  const counts = new Map<string, number>()
  for (const observation of acceptable) {
    const key = observation.key
    if (key === undefined) throw new Error("Accepted response lacks a successor state.")
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const entropy = -[...counts.values()].reduce((sum, count) => { const p = count / acceptable.length; return sum + p * Math.log(p) }, 0)
  return 100 * acceptable.length / group.observations.length * entropy / Math.log(group.acceptableStateCount)
}
function prepare(observations: readonly BehaviorObservation[], positions: readonly BehaviorPosition[], condition: BehaviorCondition, depth: 2 | 4, tolerance: number, keys: Map<string, Map<string, string>>): PreparedPosition[] {
  return positions.filter(position => position.stratum !== "forced").flatMap(position => {
    const samples = observations.filter(observation => observation.positionId === position.id && observation.condition === condition).sort((a, b) => a.repetition - b.repetition)
    if (!samples.length) return []
    const reference = depth === 4 ? position.reference4 : position.reference2
    const moves = new Map(reference.moves.map(move => [move.id, move]))
    const unsafe = new Set(position.unsafeMoveIds)
    const accepted = new Set(reference.moves.filter(move => move.regret <= tolerance && !unsafe.has(move.id)).map(move => move.id))
    const successorKeys = keys.get(position.id)
    if (!successorKeys) throw new Error(`Missing successor states for ${position.id}`)
    const states = new Set([...accepted].map(id => successorKeys.get(id)))
    const best = new Set(reference.bestMoveIds), canonical = [...best].sort()[0]
    return [{ position, acceptableStateCount: states.size, observations: samples.map(observation => {
      const move = observation.moveId ? moves.get(observation.moveId) : undefined
      const valid = observation.legal && !observation.error && move !== undefined
      const key = valid ? successorKeys.get(move.id) : undefined
      if (valid && observation.successorKey !== undefined && observation.successorKey !== key) throw new Error(`Successor mismatch for ${position.id}: ${move.id}`)
      return { valid, key, acceptable: valid && accepted.has(move.id), regret: valid ? move.regret : undefined,
        anyBest: valid && best.has(move.id), canonicalBest: valid && move.id === canonical,
        policy: valid && position.recommendedIds.includes(move.id),
        hasFirstCard: valid && observation.firstCardId !== undefined, firstCard: valid && move.id === observation.firstCardId,
        hasFirstRecommended: valid && observation.firstRecommendedId !== undefined, firstRecommended: valid && move.id === observation.firstRecommendedId }
    }) }]
  })
}
function confidence(groups: readonly PreparedPosition[]): BehaviorConditionMetrics["confidence95"] {
  if (!groups.length) return { repeatability: null, safeVariety: null }
  let seed = 0x51f15e
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x1_0000_0000 }
  const repeats: number[] = [], varieties: number[] = []
  // Position clusters, then repeated decisions: deterministic analysis, not model RNG.
  for (let resample = 0; resample < 1000; resample++) {
    const sampled = Array.from({ length: groups.length }, () => {
      const group = groups[Math.floor(random() * groups.length)]
      return { ...group, observations: Array.from({ length: group.observations.length }, () => group.observations[Math.floor(random() * group.observations.length)]) }
    })
    const r = average(sampled.map(group => pairwiseRepeatability(group.observations)).filter((value): value is number => value !== null))
    const v = average(sampled.map(safeVariety).filter((value): value is number => value !== null))
    if (r !== null) repeats.push(r)
    if (v !== null) varieties.push(v)
  }
  const interval = (values: number[]): [number, number] | null => {
    if (!values.length) return null
    values.sort((a, b) => a - b)
    return [values[Math.floor((values.length - 1) * 0.025)], values[Math.ceil((values.length - 1) * 0.975)]]
  }
  return { repeatability: interval(repeats), safeVariety: interval(varieties) }
}
function conditionMetrics(groups: readonly PreparedPosition[], observations: readonly BehaviorObservation[], positions: readonly BehaviorPosition[], condition: BehaviorCondition): BehaviorConditionMetrics {
  const samples = groups.flatMap(group => group.observations), valid = samples.filter(sample => sample.valid)
  const regrets = valid.flatMap(sample => sample.regret === undefined ? [] : [sample.regret])
  const measured = groups.map(group => pairwiseRepeatability(group.observations)).filter((value): value is number => value !== null)
  const free = groups.filter(group => group.position.stratum === "free" && group.acceptableStateCount >= 2)
  const policySamples = groups.filter(group => group.position.recommendedIds.length > 0).flatMap(group => group.observations)
  const hashes = condition === "fixed" ? groups.map(group => new Set(observations.filter(sample => sample.positionId === group.position.id && sample.condition === condition).flatMap(sample => sample.inputHash ? [sample.inputHash] : []))).filter(set => set.size > 0) : []
  const forced = new Set(positions.filter(position => position.stratum === "forced").map(position => position.id))
  return {
    attempts: samples.length, legalResponses: valid.length, errors: samples.length - valid.length,
    forcedObservations: observations.filter(sample => sample.condition === condition && forced.has(sample.positionId)).length,
    positionCount: groups.length, freeChoicePositions: free.length,
    recommendationSingletonPositions: groups.filter(group => group.position.recommendedIds.length === 1).length,
    repeatability: average(measured),
    freeChoiceRepeatability: average(free.map(group => pairwiseRepeatability(group.observations)).filter((value): value is number => value !== null)),
    safeVariety: average(groups.map(safeVariety).filter((value): value is number => value !== null)),
    referenceAcceptableRate: rate(samples.filter(sample => sample.acceptable).length, samples.length),
    meanRegret: average(regrets), medianRegret: median(regrets), worstRegret: regrets.length ? Math.max(...regrets) : null,
    engineAnyBestAgreement: rate(samples.filter(sample => sample.anyBest).length, samples.length),
    engineCanonicalAgreement: rate(samples.filter(sample => sample.canonicalBest).length, samples.length),
    policyAdherence: rate(policySamples.filter(sample => sample.policy).length, policySamples.length),
    acceptableOutsidePolicyRate: rate(policySamples.filter(sample => sample.acceptable && !sample.policy).length, policySamples.length),
    firstCardRate: rate(valid.filter(sample => sample.firstCard).length, valid.filter(sample => sample.hasFirstCard).length),
    firstRecommendedRate: rate(valid.filter(sample => sample.firstRecommended).length, valid.filter(sample => sample.hasFirstRecommended).length),
    fixedInputPositionsChecked: hashes.length, fixedInputPositionsChanged: hashes.filter(set => set.size > 1).length,
    confidence95: confidence(groups)
  }
}

/**
 * Independent operational scores, not complements: Skill is an equal-weight
 * geometric mean of tactical success and depth-4 reference acceptance. Safe
 * variety measures entropy among acceptable successor states, multiplied by
 * their success rate; random errors cannot earn variety credit. Neither score
 * establishes human-likeness or Elo, and reference acceptance is horizon- and
 * heuristic-dependent. CIs describe this selected suite, not a human population.
 */
export function summarizeBehavior(observations: readonly BehaviorObservation[], positions: readonly BehaviorPosition[], tactical: { passed: number; total: number }) {
  if (new Set(positions.map(position => position.id)).size !== positions.length) throw new Error("Behavior position IDs must be unique.")
  const ids = new Set(positions.map(position => position.id))
  if (observations.some(observation => !ids.has(observation.positionId))) throw new Error("Observation has an unknown behavior position.")
  if (!Number.isInteger(tactical.total) || !Number.isInteger(tactical.passed) || tactical.total < 0 || tactical.passed < 0 || tactical.passed > tactical.total) throw new Error("Invalid tactical counts.")
  const keys = new Map(positions.map(position => [position.id, new Map(position.reference4.moves.map(move => [move.id, successorStateKey(applyMove(position.game, move.id))]))]))
  const conditions = Object.fromEntries((["fixed", "game-seeded"] as const).map(condition => [condition, conditionMetrics(prepare(observations, positions, condition, 4, REFERENCE_TOLERANCE, keys), observations, positions, condition)])) as Record<BehaviorCondition, BehaviorConditionMetrics>
  const attempts = conditions.fixed.attempts + conditions["game-seeded"].attempts
  const acceptable = (["fixed", "game-seeded"] as const).flatMap(condition => prepare(observations, positions, condition, 4, REFERENCE_TOLERANCE, keys)).flatMap(group => group.observations).filter(sample => sample.acceptable).length
  const referenceAcceptableRate = rate(acceptable, attempts), tacticalSuccessRate = rate(tactical.passed, tactical.total)
  const sensitivity = Object.fromEntries(([2, 4] as const).map(depth => [`depth${depth}`, [0, 25, 50].map(tolerance => ({ tolerance,
    conditions: Object.fromEntries((["fixed", "game-seeded"] as const).map(condition => {
      const groups = prepare(observations, positions, condition, depth, tolerance, keys), samples = groups.flatMap(group => group.observations)
      return [condition, { referenceAcceptableRate: rate(samples.filter(sample => sample.acceptable).length, samples.length), safeVariety: average(groups.map(safeVariety).filter((value): value is number => value !== null)), freeChoicePositions: groups.filter(group => group.position.stratum === "free" && group.acceptableStateCount >= 2).length }]
    }))
  }))]))
  return {
    version: BEHAVIOR_METRICS_VERSION,
    skillScore: tacticalSuccessRate === null || referenceAcceptableRate === null ? null : Math.sqrt(tacticalSuccessRate * referenceAcceptableRate),
    tacticalSuccessRate, referenceAcceptableRate, conditions, sensitivity,
    notes: ["Scores are operational and reference-dependent, not Elo or a validated human-likeness/creativity measure.", "Safe variety is outcome entropy on free-choice positions; recommendation-singleton and forced decisions are reported separately.", "Exact-repeat scores require identical recorded prompt/schema hashes. Game-seeded variation can reflect presentation-order sensitivity.", "The paired nested bootstrap resamples selected positions and their repetitions; unseen moves and finite-sample entropy bias remain."]
  }
}
