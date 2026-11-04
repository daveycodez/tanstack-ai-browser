import type { EndgameTieSolver } from "./endgame-ties.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV14,
  PROMPT_VERSIONS as HISTORICAL_VERSIONS
} from "./shared-prompt-v14.ts"
import type {
  PromptInput as V14Input,
  EngineAction as HistoricalAction,
  EngineReport as HistoricalReport
} from "./shared-prompt-v14.ts"
import { solveGameOutcomes } from "./outcome-proof.ts"
import type { GameOutcome } from "./outcome-proof.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v14.ts"
export type { MoveAnalysis } from "./shared-prompt-v14.ts"

export const SHARED_PROMPT_VERSION = "shared-v15" as const
export const PROMPT_VERSIONS = [
  ...HISTORICAL_VERSIONS,
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type EngineAction = HistoricalAction & {
  outcomeProof?: {
    kind: "FULL_GAME_OUTCOME"
    outcome: GameOutcome
    basis: "terminal-or-secured-majority"
  }
}
export type EngineReport = Omit<HistoricalReport, "actions"> & {
  actions: EngineAction[]
  evaluationScope?: "Earlier evaluations retain their original scope as diagnostics; outcomeProof alone ranks these actions."
}
export type PromptInput = Omit<V14Input, "version" | "report"> & {
  version: PromptVersion
  report?: EngineReport
  outcomeComparison?: ReturnType<typeof solveGameOutcomes>
}

/** Used only when a complete proof strictly improves the previous recommendation. */
export const SHARED_SYSTEM_PROMPT = [
  "You control AI in Kalah. Choose an exact supplied legal action label. The full-game outcome report proves the result for AI under best play by both sides, through a terminal finish or a secured majority of more than 24 seeds.",
  "WIN is better than DRAW, and DRAW is better than DEFEAT. BEST marks every action in the strongest proved outcome class. Follow RECOMMENDED AI ACTION, a representative of that class. Captures, immediate store gains and bonus sows cannot justify a worse proved outcome. Actions in the same class have not been ranked by exact final seed scores.",
  "The earlier bounded recommendation has been replaced by these full-game outcome classes. Do not reuse its illustrative plans, opponent capture exposure, or short-horizon margins to contradict the proof. All legal alternatives remain listed for validation. Return only JSON with key pit and the complete recommended action label."
].join("\n\n")
const rank = (outcome: GameOutcome) =>
  outcome === "ai-win" ? 1 : outcome === "human-win" ? -1 : 0
const resultForAI = (outcome: GameOutcome): EngineAction["resultForAI"] =>
  outcome === "ai-win" ? "WIN" : outcome === "human-win" ? "LOSS" : "DRAW"
const rowFor = (action: EngineAction) => {
  const result =
    action.resultForAI === "WIN"
      ? "PROVED WIN FOR YOU"
      : action.resultForAI === "DRAW"
        ? "PROVED DRAW FOR YOU"
        : "PROVED DEFEAT FOR YOU"
  return `${action.label} | ${action.preferred ? "BEST" : "OTHER"} | ${result} | capture now ${action.now.capture}; store gain now ${action.now.storeGain}; bonus ${action.now.bonus ? "yes" : "no"}`
}

/** Preserve v14 model strings unless an all-action proof establishes a strictly
 * better win/draw/loss class. This advises the model; it never replaces its answer.
 */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION,
  endgameSolver: EndgameTieSolver = createEndgameTieRequest().solve
): PromptInput {
  if (version !== SHARED_PROMPT_VERSION)
    return buildV14(game, moves, version, endgameSolver)
  const base = buildV14(game, moves, undefined, endgameSolver)
  const recommended = base.report?.actions.find(
    (action) => action.label === base.recommendedAction
  )
  if (
    moves.length < 2 ||
    moves.length !== legalMoves(game.board, "ai").length ||
    base.analysis.some((action) => action.immediateStatus === "ai-won") ||
    base.finalComparison?.complete ||
    recommended?.resultForAI === "WIN" ||
    48 - game.board[6] - game.board[13] > 24
  )
    return { ...base, version }

  const outcomeComparison = solveGameOutcomes(game, moves)
  const unchanged: PromptInput = { ...base, version, outcomeComparison }
  if (!outcomeComparison.complete) return unchanged
  const recommendedPit = base.choices.find(
    (choice) => choice.label === base.recommendedAction
  )?.id
  const currentProof = outcomeComparison.moves.find(
    (move) => move.pit === recommendedPit
  )
  const bestClass = Math.max(
    ...outcomeComparison.moves.map((move) => rank(move.outcome))
  )
  if (currentProof && rank(currentProof.outcome) === bestClass) return unchanged
  if (!base.report)
    throw new Error(
      "A full-game outcome review needs the original immediate action facts."
    )

  const bestPits = new Set(outcomeComparison.bestPits)
  const proved = new Map(
    outcomeComparison.moves.map((move) => [move.pit, move.outcome])
  )
  const actions: EngineAction[] = base.choices.map((choice) => {
    const previous = base.report?.actions.find(
      (action) => action.label === choice.label
    )
    const outcome = proved.get(choice.id)
    if (!previous || !outcome)
      throw new Error(
        "A full-game outcome review must include every legal action and its immediate facts."
      )
    return {
      label: previous.label,
      preferred: bestPits.has(choice.id),
      resultForAI: resultForAI(outcome),
      now: previous.now,
      evaluation: previous.evaluation,
      outcomeProof: {
        kind: "FULL_GAME_OUTCOME",
        outcome,
        basis: "terminal-or-secured-majority"
      }
    }
  })
  const terminalDraw =
    bestClass === 0
      ? actions.find((action) => action.preferred && action.now.endsGame)?.label
      : undefined
  const previousPreferredPit = base.priorityPits?.find((pit) =>
    bestPits.has(pit)
  )
  const previousPreferredLabel = base.choices.find(
    (choice) => choice.id === previousPreferredPit
  )?.label
  const recommendedAction =
    terminalDraw ??
    previousPreferredLabel ??
    actions.find((action) => action.preferred)?.label
  if (!recommendedAction)
    throw new Error(
      "A completed full-game proof needs a preferred legal action."
    )
  const preferredActions = [
    recommendedAction,
    ...actions
      .filter(
        (action) => action.preferred && action.label !== recommendedAction
      )
      .map((action) => action.label)
  ]
  const report: EngineReport = {
    ...base.report,
    actions,
    preferredActions,
    evaluationScope:
      "Earlier evaluations retain their original scope as diagnostics; outcomeProof alone ranks these actions."
  }
  const choices = base.choices.map((choice, i) => ({
    ...choice,
    outcome: rowFor(actions[i])
  }))
  return {
    ...base,
    version,
    outcomeComparison,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    report,
    choices,
    priorityPits: moves.filter((pit) => bestPits.has(pit)),
    recommendedAction,
    prompt: [
      `KALAH. AI to move. Current stores: AI ${report.stores.AI}; opponent ${report.stores.opponent}.`,
      "FULL-GAME OUTCOME REVIEW: Every legal action has a proved AI outcome under best play, through a terminal finish or a secured majority. WIN beats DRAW; DRAW beats DEFEAT. These classes replace the earlier recommendation. No exact final seed scores are claimed.",
      "INDEPENDENT LEGAL AI ACTIONS:",
      ...choices.map((choice) => choice.outcome),
      `RECOMMENDED AI ACTION: ${JSON.stringify(recommendedAction)}`
    ].join("\n")
  }
}
