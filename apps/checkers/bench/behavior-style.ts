import { applyMove, colorForSide, legalMoves, newGame, positionKey } from "../src/lib/checkers.ts"
import type { Board, PieceColor, Side } from "../src/lib/checkers.ts"
import type { BehaviorTrace } from "./behavior-rollouts.ts"

export type BehaviorStyleTrace = Pick<BehaviorTrace, "id" | "initialTurn" | "humanColor" | "finalGame" | "status"> & {
  moves: { ply: number; side: Side; moveId: string; referenceRegret?: number }[]
}
/** Engine scores describe decision quality, not whether a player seems human. */
export type BehaviorStyleQuality = { ply: number; regret: number; terminalBlunder?: boolean }
export type BehaviorStyleOptions = {
  quality?: readonly BehaviorStyleQuality[]
  qualitySource?: string
  acceptableRegret?: number
  severeRegret?: number
  side?: Side
}
const percent = (count: number, total: number) => total ? 100 * count / total : null
const distance = (a: number, b: number) => Math.max(Math.abs(Math.floor(a / 8) - Math.floor(b / 8)), Math.abs(a % 8 - b % 8))
function nearestOpponent(board: Board, square: number, side: Side): number | null {
  const squares = board.flatMap((piece, index) => piece && piece.side !== side ? [index] : [])
  return squares.length ? Math.min(...squares.map(target => distance(square, target))) : null
}
function initialGame(trace: BehaviorStyleTrace) {
  const game = newGame(trace.humanColor)
  game.board = structuredClone(trace.finalGame.initialBoard ?? game.board)
  game.turn = trace.initialTurn
  game.history = []
  game.positions = [positionKey(game.board, game.turn)]
  return game
}

/**
 * Observable style profile. Reversals, pursuit, and same-piece follow-through are
 * proxies only: retreats may be correct, and coherent plans can switch pieces.
 * No composite "human-likeness" number is manufactured from these counts.
 */
export function profileBehaviorTrace(trace: BehaviorStyleTrace, options: BehaviorStyleOptions = {}) {
  const side = options.side ?? "ai", acceptable = options.acceptableRegret ?? 25, severe = options.severeRegret ?? 100
  if (!Number.isFinite(acceptable) || !Number.isFinite(severe) || acceptable < 0 || severe <= acceptable) throw new Error("Invalid regret thresholds.")
  const quality = new Map(options.quality?.map(item => [item.ply, item]))
  let game = initialGame(trace)
  const identities = game.board.map((piece, index) => piece ? index : null)
  const visits = new Map([[positionKey(game.board, game.turn), 1]])
  let previous: { identity: number | null; origin: number; destination: number; captures: number } | undefined
  let decisions = 0, forced = 0, captures = 0, promotions = 0, quietDecisions = 0, reversals = 0, repeatedPositions = 0
  let followThroughOpportunities = 0, samePieceFollowThrough = 0, pawnAdvances = 0, kingPursuitOpportunities = 0, kingApproaches = 0
  const scored: BehaviorStyleQuality[] = []
  for (const record of trace.moves) {
    const moves = legalMoves(game.board, game.turn), move = moves.find(candidate => candidate.id === record.moveId)
    if (record.side !== game.turn || !move) throw new Error(`Invalid trace at ply ${record.ply}.`)
    const origin = move.path[0], destination = move.path.at(-1), piece = game.board[origin], identity = identities[origin]
    if (destination === undefined || !piece) throw new Error(`Incomplete move at ply ${record.ply}.`)
    if (record.side === side) {
      if (moves.length === 1) forced++
      else {
        decisions++
        if (options.quality) { const item = quality.get(record.ply); if (item && Number.isFinite(item.regret) && item.regret >= 0) scored.push(item) }
        else if (typeof record.referenceRegret === "number" && Number.isFinite(record.referenceRegret) && record.referenceRegret >= 0) scored.push({ ply: record.ply, regret: record.referenceRegret })
        if (move.captures.length === 0) {
          quietDecisions++
          if (previous && previous.captures === 0 && identity === previous.identity && origin === previous.destination && destination === previous.origin) reversals++
          if (!piece.king) pawnAdvances++
          else {
            const before = nearestOpponent(game.board, origin, side), after = nearestOpponent(game.board, destination, side)
            if (before !== null && after !== null) { kingPursuitOpportunities++; if (after < before) kingApproaches++ }
          }
        }
        if (previous) { followThroughOpportunities++; if (identity === previous.identity) samePieceFollowThrough++ }
      }
      captures += move.captures.length
      promotions += Number(move.promotes)
      previous = { identity, origin, destination, captures: move.captures.length }
    }
    identities[origin] = null
    for (const capture of move.captures) identities[capture] = null
    identities[destination] = identity
    game = applyMove(game, move.id)
    const key = positionKey(game.board, game.turn), count = visits.get(key) ?? 0
    if (record.side === side && count > 0) repeatedPositions++
    visits.set(key, count + 1)
  }
  const acceptableCount = scored.filter(item => item.regret <= acceptable && !item.terminalBlunder).length
  const severeCount = scored.filter(item => item.regret > severe || item.terminalBlunder).length
  return {
    traceId: trace.id, side, plies: trace.moves.length, status: trace.status, decisions, forced,
    quality: { source: options.qualitySource ?? (options.quality ? "supplied reference (unspecified)" : "trace reference (not independent)"), units: "reference score units",
      acceptableThreshold: acceptable, severeThreshold: severe, scored: scored.length, unscored: decisions - scored.length,
      acceptable: acceptableCount, costly: scored.length - acceptableCount - severeCount, severe: severeCount,
      acceptableRate: percent(acceptableCount, scored.length), meanRegret: scored.length ? scored.reduce((sum, item) => sum + item.regret, 0) / scored.length : null,
      worstRegret: scored.length ? Math.max(...scored.map(item => item.regret)) : null },
    activity: { captures, promotions, quietDecisions, pawnAdvances, kingPursuitOpportunities, kingApproaches,
      kingApproachRate: percent(kingApproaches, kingPursuitOpportunities) },
    continuity: { followThroughOpportunities, samePieceFollowThrough, samePieceRate: percent(samePieceFollowThrough, followThroughOpportunities) },
    repetition: { quietReversals: reversals, quietReversalRate: percent(reversals, quietDecisions), repeatedPositions },
    interpretation: "Descriptive proxies, not a validated human-style score. Match playing strength and obtain blinded human ratings; short capped traces cannot establish endgame behavior or game strength.",
  }
}

export type BlindStyleRatings = {
  coherentPlans: number; plausibleChoices: number; interestingVariety: number; avoidsAimlessRepetition: number
}
export type BlindStyleReview = {
  pairId: string; reviewerId: string; preferred: "A" | "B" | "tie" | "uncertain"
  A: BlindStyleRatings; B: BlindStyleRatings
  expertise: "new" | "casual" | "experienced"; confidence: "low" | "medium" | "high"
  strengthComparable: "yes" | "no" | "uncertain"
}
export type BlindStyleCandidate = { label: string; trace: BehaviorStyleTrace }
function hash(text: string) { let value = 2166136261; for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619); return value >>> 0 }
function blindCard(trace: BehaviorStyleTrace) {
  if (trace.status === "error" || trace.status === "stopped") throw new Error("An incomplete failed trace cannot enter a blind comparison.")
  const game = initialGame(trace)
  return { initialBoard: game.board.map(piece => piece ? { color: colorForSide(game, piece.side), king: piece.king } : null),
    initialColor: colorForSide(game, game.turn), opponentColor: colorForSide(game, "ai"), moves: trace.moves.map(move => ({ ply: move.ply, color: colorForSide(game, move.side), move: move.moveId })),
    ending: trace.status === "capped" ? "capped" : trace.status === "draw" ? "draw" : `${colorForSide(game, trace.status === "ai-won" ? "ai" : "human")} won` }
}

/** Keep privateKey out of the reviewer payload until ratings have been submitted. */
export function createBlindReviewPair(options: { id: string; a: BlindStyleCandidate; b: BlindStyleCandidate; salt: string }) {
  const [A, B] = hash(`${options.salt}:${options.id}`) % 2 ? [options.b, options.a] : [options.a, options.b]
  return { public: { pairId: options.id, A: blindCard(A.trace), B: blindCard(B.trace),
    question: "Which opponent feels more like a human casual player? Rate plan coherence, plausible choices, interesting variety, and avoidance of aimless repetition from 1 (low) to 5 (high). Assess style separately from strength; choose uncertain when the evidence is insufficient." },
    privateKey: { pairId: options.id, A: A.label, B: B.label } }
}

export function summarizeBlindStyleReviews(reviews: readonly BlindStyleReview[], keys: readonly { pairId: string; A: string; B: string }[]) {
  const dimensions = ["coherentPlans", "plausibleChoices", "interestingVariety", "avoidsAimlessRepetition"] as const
  const raters = new Set<string>()
  const mapping = new Map(keys.map(key => [key.pairId, key]))
  if (mapping.size !== keys.length) throw new Error("Duplicate private identity key.")
  const opponents = new Map<string, { ratings: BlindStyleRatings[]; preferences: number; comparableStrengthRatings: number }>()
  for (const review of reviews) {
    const key = `${review.pairId}:${review.reviewerId}`
    if (raters.has(key)) throw new Error("A reviewer may rate each pair only once.")
    raters.add(key)
    for (const card of [review.A, review.B]) for (const dimension of dimensions) if (!Number.isInteger(card[dimension]) || card[dimension] < 1 || card[dimension] > 5) throw new Error("Blind ratings must be integers from 1 to 5.")
    const identity = mapping.get(review.pairId)
    if (!identity || identity.A === identity.B) throw new Error("Each reviewed pair needs two distinct private identities.")
    for (const card of ["A", "B"] as const) {
      const entry = opponents.get(identity[card]) ?? { ratings: [], preferences: 0, comparableStrengthRatings: 0 }
      entry.ratings.push(review[card]); entry.preferences += Number(review.preferred === card); entry.comparableStrengthRatings += Number(review.strengthComparable === "yes")
      opponents.set(identity[card], entry)
    }
  }
  return { ratings: reviews.length, uniqueReviewers: new Set(reviews.map(review => review.reviewerId)).size,
    comparableStrengthRatings: reviews.filter(review => review.strengthComparable === "yes").length,
    ties: reviews.filter(review => review.preferred === "tie").length, uncertain: reviews.filter(review => review.preferred === "uncertain").length,
    opponents: Object.fromEntries([...opponents].map(([identity, entry]) => [identity, { ratings: entry.ratings.length, preferences: entry.preferences,
      comparableStrengthRatings: entry.comparableStrengthRatings, mean: Object.fromEntries(dimensions.map(dimension => [dimension, entry.ratings.reduce((sum, rating) => sum + rating[dimension], 0) / entry.ratings.length])) }])),
    interpretation: "Subjective blinded ratings only. Report strength mismatches and rater experience; this is not a validated human-likeness scale." }
}

export type BlindStyleBoardPiece = { color: PieceColor; king: boolean }
