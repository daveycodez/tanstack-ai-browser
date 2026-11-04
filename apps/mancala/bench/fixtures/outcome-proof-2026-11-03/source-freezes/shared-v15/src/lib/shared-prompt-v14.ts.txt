import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { solveEndgameTies } from "./endgame-ties.ts"
import type { EndgameTieResult } from "./endgame-ties.ts"
import {
  buildMovePrompt as buildV13,
  PROMPT_VERSIONS as HISTORICAL_VERSIONS,
  SHARED_SYSTEM_PROMPT as V13_SYSTEM
} from "./shared-prompt-v13.ts"
import type {
  PromptInput as V13Input,
  EngineAction
} from "./shared-prompt-v13.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v13.ts"
export type {
  MoveAnalysis,
  EngineReport,
  EngineAction
} from "./shared-prompt-v13.ts"
export const SHARED_PROMPT_VERSION = "shared-v14" as const
export const PROMPT_VERSIONS = [
  ...HISTORICAL_VERSIONS,
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V13Input, "version"> & {
  version: PromptVersion
  finalComparison?: EndgameTieResult
}
export const SHARED_SYSTEM_PROMPT =
  V13_SYSTEM +
  "\n\nWhen an ALL-ACTION ENDGAME REVIEW is present, it compares every legal action through the final sweep under best play by both sides. It replaces the shallow preference, even if that preference was unique. Preserve an available draw over a proved defeat. Among equal outcomes maximize final AI seeds and final margin. Follow the updated BEST group and final recommendation; an immediate capture or bonus cannot override a worse proved finish."
/** A unique shallow preference can still hide a drawing alternative. */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION
): PromptInput {
  if (version !== SHARED_PROMPT_VERSION) return buildV13(game, moves, version)
  const base = buildV13(game, moves)
  const immediateWin = base.analysis.some((a) => a.immediateStatus === "ai-won")
  if (
    immediateWin ||
    moves.length < 2 ||
    moves.length !== legalMoves(game.board, "ai").length
  )
    return { ...base, version, systemPrompt: SHARED_SYSTEM_PROMPT }
  const finalComparison = solveEndgameTies(game, moves, {
    maxRemainingSeeds: 24
  })
  if (!finalComparison.complete)
    return {
      ...base,
      version,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      finalComparison
    }
  if (!base.report)
    throw new Error(
      "A current endgame comparison needs the original action facts."
    )
  const bestPits = new Set(finalComparison.bestPits)
  const bestMargin = Math.max(
    ...finalComparison.moves.map((m) => m.finalMargin)
  )
  const bestStore = Math.max(...finalComparison.moves.map((m) => m.aiStore))
  const exacts = new Map(finalComparison.moves.map((m) => [m.pit, m]))
  const actions = base.report.actions.map((action, i): EngineAction => {
    const pit = base.choices[i].id
    const exact = exacts.get(pit)
    if (!exact)
      throw new Error(
        "An all-action comparison must finish every legal action."
      )
    return {
      label: action.label,
      preferred: bestPits.has(pit),
      now: action.now,
      resultForAI:
        exact.finalMargin > 0 ? "WIN" : exact.finalMargin < 0 ? "LOSS" : "DRAW",
      evaluation: {
        kind: "EXACT_ENDGAME",
        marginForAI: exact.finalMargin,
        finalStores: { AI: exact.aiStore, opponent: exact.humanStore },
        marginBelowBest: bestMargin - exact.finalMargin,
        aiSeedsBelowBest: bestStore - exact.aiStore,
        ownTurnPits: exact.bestAiTurn.map((p) => p - 6)
      }
    }
  })
  const preferred = actions.filter((a) => a.preferred)
  const terminalDraw = preferred.every((a) => a.resultForAI === "DRAW")
    ? preferred.find((a) => a.now.endsGame)?.label
    : undefined
  const recommendedAction = terminalDraw ?? preferred[0].label
  const choices = base.choices.map((choice, i) => {
    const a = actions[i],
      e = a.evaluation
    const result =
      a.resultForAI === "WIN"
        ? "PROVED WIN FOR YOU"
        : a.resultForAI === "DRAW"
          ? "PROVED DRAW FOR YOU"
          : "PROVED DEFEAT FOR YOU"
    return {
      ...choice,
      outcome: `${a.label} | ${a.preferred ? "BEST" : "OTHER"} | ${result} | exact final AI ${e.finalStores?.AI}, opponent ${e.finalStores?.opponent}, AI margin ${e.marginForAI}; final AI seeds below best finish ${e.aiSeedsBelowBest} | capture now ${a.now.capture}; store gain now ${a.now.storeGain}; bonus ${a.now.bonus ? "yes" : "no"}`
    }
  })
  const report = {
    ...base.report,
    actions,
    preferredActions: preferred.map((a) => a.label)
  }
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    finalComparison,
    endgame: finalComparison,
    report,
    choices,
    priorityPits: moves.filter((p) => bestPits.has(p)),
    recommendedAction,
    prompt: [
      `KALAH. AI to move. Current stores: AI ${report.stores.AI}; opponent ${report.stores.opponent}.`,
      "ALL-ACTION ENDGAME REVIEW: Every legal action has been solved through the final sweep. These final results replace earlier bounded preferences, including unique shallow preferences. BEST marks the strongest final AI score under best play by both sides.",
      "INDEPENDENT LEGAL AI ACTIONS:",
      ...choices.map((c) => c.outcome),
      `RECOMMENDED AI ACTION: ${JSON.stringify(recommendedAction)}`
    ].join("\n")
  }
}
