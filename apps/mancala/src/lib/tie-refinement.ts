import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { solveEndgameTies } from "./endgame-ties.ts"
import type { EndgameTieResult } from "./endgame-ties.ts"
import { analyzeTacticalMoves } from "./move-outcomes.ts"
import type { TacticalMoveOutcome } from "./move-outcomes.ts"

export type TieRefinementOptions = {
  /** Every legal root from the current position, at the common baseline horizon. */
  baseline: readonly TacticalMoveOutcome[]
  maxEndgameNodes?: number
  maxNodesPerMove?: number
  maxSafetyNodes?: number
}
export type TieRefinementResult =
  | {
      kind: "exact"
      bestPits: number[]
      endgame: EndgameTieResult
      horizon: null
      nodes: number
    }
  | {
      kind: "bounded"
      bestPits: number[]
      outcomes: TacticalMoveOutcome[]
      endgame: EndgameTieResult
      horizon: number
      nodes: number
    }
  | {
      kind: "unchanged"
      bestPits: number[]
      horizon: number
      nodes: number
      reason:
        | "not-playing"
        | "single-choice"
        | "incomplete-baseline"
        | "not-tied"
        | "max-horizon"
        | "incomplete-search"
      endgame?: EndgameTieResult
    }

/** Refine a real shared-score tie, never introduce a root outside that group.
 * Supplied baseline work is not repeated or included in nodes. Each attempted
 * deeper horizon retains the historical per-root budget; nodes includes every
 * attempt, handoff-safety work, and any unsuccessful terminal search.
 * A fallback can complete an odd number of turns. That is a bounded preview,
 * not a claim that both sides have taken the same number of turns or a final score.
 */
export function refineTiedChoices(
  game: Game,
  candidates: readonly number[],
  baseTurns: number,
  options: TieRefinementOptions
): TieRefinementResult {
  if (!Number.isSafeInteger(baseTurns) || baseTurns < 2 || baseTurns > 8)
    throw new RangeError("Choose a baseline horizon from two to eight turns.")
  for (const limit of [
    options.maxEndgameNodes,
    options.maxNodesPerMove,
    options.maxSafetyNodes
  ])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new RangeError("Choose positive integer refinement limits.")
  const unchanged = (
    reason: Extract<TieRefinementResult, { kind: "unchanged" }>["reason"],
    nodes = 0,
    endgame?: EndgameTieResult
  ): TieRefinementResult => ({
    kind: "unchanged",
    bestPits: [...candidates],
    horizon: baseTurns,
    nodes,
    reason,
    ...(endgame ? { endgame } : {})
  })
  if (game.status !== "playing" || game.turn !== "ai")
    return unchanged("not-playing")
  const allowed = legalMoves(game.board, "ai")
  if (
    new Set(candidates).size !== candidates.length ||
    candidates.some((pit) => !allowed.includes(pit))
  )
    throw new Error("Tie candidates must be distinct legal AI pits.")
  if (candidates.length <= 1) return unchanged("single-choice")
  const baseline = options.baseline
  if (
    baseline.length !== allowed.length ||
    new Set(baseline.map((outcome) => outcome.pit)).size !== baseline.length ||
    baseline.some((outcome) => !allowed.includes(outcome.pit))
  )
    throw new Error(
      "The tie baseline must contain every current legal AI pit exactly once."
    )
  if (
    baseline.some(
      (outcome) =>
        !outcome.complete ||
        outcome.completeTurnsChecked !== baseTurns ||
        outcome.checkedScore === null ||
        !Number.isFinite(outcome.checkedScore)
    )
  )
    return unchanged("incomplete-baseline")
  const best = Math.max(
    ...baseline.map((outcome) => outcome.checkedScore as number)
  )
  const tied = baseline.filter((outcome) => outcome.checkedScore === best)
  if (
    tied.length !== candidates.length ||
    tied.some((outcome) => !candidates.includes(outcome.pit))
  )
    return unchanged("not-tied")

  const endgame = solveEndgameTies(game, candidates, {
    maxRemainingSeeds: 24,
    ...(options.maxEndgameNodes === undefined
      ? {}
      : { maxNodes: options.maxEndgameNodes })
  })
  if (endgame.complete)
    return {
      kind: "exact",
      bestPits: endgame.bestPits,
      endgame,
      horizon: null,
      nodes: endgame.nodes
    }
  if (baseTurns === 8) return unchanged("max-horizon", endgame.nodes, endgame)
  const outcomes = analyzeTacticalMoves(game, candidates, {
    turns: 8,
    minimumTurns: baseTurns + 1,
    ...(options.maxNodesPerMove === undefined
      ? {}
      : { maxNodesPerMove: options.maxNodesPerMove }),
    ...(options.maxSafetyNodes === undefined
      ? {}
      : { maxSafetyNodes: options.maxSafetyNodes })
  })
  const nodes =
    endgame.nodes + outcomes.reduce((sum, outcome) => sum + outcome.nodes, 0)
  const horizon = outcomes[0]?.completeTurnsChecked ?? 0
  if (
    horizon <= baseTurns ||
    outcomes.length !== candidates.length ||
    outcomes.some(
      (outcome) =>
        !outcome.complete ||
        outcome.completeTurnsChecked !== horizon ||
        outcome.checkedScore === null
    )
  )
    return unchanged("incomplete-search", nodes, endgame)
  const improvedBest = Math.max(
    ...outcomes.map((outcome) => outcome.checkedScore as number)
  )
  return {
    kind: "bounded",
    bestPits: outcomes
      .filter((outcome) => outcome.checkedScore === improvedBest)
      .map((outcome) => outcome.pit),
    outcomes,
    endgame,
    horizon,
    nodes
  }
}
