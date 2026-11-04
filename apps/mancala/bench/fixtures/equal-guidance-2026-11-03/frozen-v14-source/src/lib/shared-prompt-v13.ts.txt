import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV12,
  PROMPT_VERSIONS as HISTORICAL_VERSIONS,
  SHARED_SYSTEM_PROMPT as V12_SYSTEM
} from "./shared-prompt-v12.ts"
import type {
  PromptInput as V12Input,
  EngineAction
} from "./shared-prompt-v12.ts"
import { refineTiedChoices } from "./tie-refinement.ts"
import type { TacticalMoveOutcome } from "./move-outcomes.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v12.ts"
export type {
  MoveAnalysis,
  EngineReport,
  EngineAction
} from "./shared-prompt-v12.ts"
export const SHARED_PROMPT_VERSION = "shared-v13" as const
export const PROMPT_VERSIONS = [
  ...HISTORICAL_VERSIONS,
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V12Input, "version"> & {
  version: PromptVersion
  tieRefinement?: ReturnType<typeof refineTiedChoices>
}
export const SHARED_SYSTEM_PROMPT =
  V12_SYSTEM +
  "\n\nA short-horizon tie does not prove equal full-game quality. When a TIE REVIEW is present, its fully checked comparison resolves only the earlier tied candidates. Use its updated BEST group and final recommended action. Exact final margins outrank bounded previews; a deeper bounded margin remains a preview, even if it proves that the opponent can force a win. A large immediate capture cannot override a better checked continuation. Never compare numbers from different horizons as though they share one scale."
function boundedAction(
  t: TacticalMoveOutcome,
  label: string,
  preferred: boolean
): EngineAction {
  return {
    label,
    preferred,
    resultForAI:
      t.guaranteedOutcome === "ai-win"
        ? "WIN"
        : t.guaranteedOutcome === "human-win"
          ? "LOSS"
          : "UNPROVED",
    now: {
      capture: t.captured,
      storeGain: t.storeGain,
      bonus: t.extraTurn,
      endsGame: t.immediateStatus !== "playing"
    },
    evaluation: {
      kind: "BOUNDED_TURNS",
      marginForAI: t.checkedMargin,
      turns: t.completeTurnsChecked
    },
    ownTurn: {
      pits: t.bestAiTurn.map((p) => p - 6),
      securedStoreGain: t.aiTurnStoreGain,
      capture: t.aiTurnCapture
    },
    opponentReply: {
      fullyChecked: t.safetyChecked,
      captureTotal: t.maxHumanTurnCapture,
      canWin: t.humanCanWinNext,
      ...(t.humanSteal
        ? {
            witness: {
              pits: t.humanSteal.path.map((p) => p + 1),
              totalCaptured: t.humanSteal.totalCaptured,
              aiSeedsStolen: t.humanSteal.totalStolen,
              captures: t.humanSteal.captures.map((c) => ({
                landingOpponentPit: c.landingPit + 1,
                targetAIPit: c.targetPit - 6,
                aiSeedsStolen: c.stolenSeeds,
                totalCaptured: c.captured
              }))
            }
          }
        : {})
    }
  }
}
function reviewedRow(a: EngineAction) {
  const e = a.evaluation
  const result =
    a.resultForAI === "WIN"
      ? "PROVED WIN FOR YOU"
      : a.resultForAI === "LOSS"
        ? "PROVED DEFEAT FOR YOU"
        : a.resultForAI === "DRAW"
          ? "PROVED DRAW FOR YOU"
          : "AI UNPROVED"
  const evaluation =
    e.kind === "EXACT_ENDGAME"
      ? `exact final AI ${e.finalStores?.AI}, opponent ${e.finalStores?.opponent}, AI margin ${e.marginForAI}; final AI seeds below best compared finish ${e.aiSeedsBelowBest}`
      : `${e.turns} complete turns, AI margin ${e.marginForAI} (bounded)`
  return `${a.label} | ${a.preferred ? "BEST" : "OTHER"} | TIE REVIEW: ${result} | ${evaluation} | capture now ${a.now.capture}; store gain now ${a.now.storeGain}; bonus ${a.now.bonus ? "yes" : "no"}${a.opponentReply ? `; opponent capture exposure ${a.opponentReply.captureTotal ?? "unknown"}; AI-defeat reply exists ${a.opponentReply.canWin === null ? "unknown" : a.opponentReply.canWin ? "yes" : "no"}` : ""}`
}
/** Resolve genuine bounded ties with deeper checked context; the model still selects every move. */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION
): PromptInput {
  if (version !== SHARED_PROMPT_VERSION) return buildV12(game, moves, version)
  const base = buildV12(game, moves)
  const priorities = base.priorityPits ?? []
  const tactical = base.analysis.flatMap((a) =>
    a.tactical ? [a.tactical] : []
  )
  const terminalPriority = tactical.some(
    (t) => priorities.includes(t.pit) && t.immediateStatus !== "playing"
  )
  if (
    base.endgame?.complete ||
    priorities.length < 2 ||
    tactical.length !== legalMoves(game.board, "ai").length ||
    terminalPriority ||
    !base.report
  )
    return { ...base, version, systemPrompt: SHARED_SYSTEM_PROMPT }
  const baseTurns = tactical[0]?.completeTurnsChecked ?? 0
  const tieRefinement = refineTiedChoices(game, priorities, baseTurns, {
    baseline: tactical
  })
  if (tieRefinement.kind === "unchanged")
    return {
      ...base,
      version,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      tieRefinement
    }
  const preferred = new Set(tieRefinement.bestPits)
  const actions = base.report.actions.map((action, i): EngineAction => {
    const pit = base.choices[i].id
    if (!priorities.includes(pit)) return { ...action, preferred: false }
    if (tieRefinement.kind === "bounded") {
      const outcome = tieRefinement.outcomes.find((t) => t.pit === pit)
      if (!outcome)
        throw new Error("A tie review must include every compared action.")
      return boundedAction(outcome, action.label, preferred.has(pit))
    }
    const exact = tieRefinement.endgame.moves.find((t) => t.pit === pit)
    if (!exact)
      throw new Error("An exact tie review must include every compared action.")
    const bestStore = Math.max(
      ...tieRefinement.endgame.moves.map((m) => m.aiStore)
    )
    const bestMargin = Math.max(
      ...tieRefinement.endgame.moves.map((m) => m.finalMargin)
    )
    return {
      label: action.label,
      preferred: preferred.has(pit),
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
  const preferredActions = actions
    .filter((a) => a.preferred)
    .map((a) => a.label)
  const recommendedAction = preferredActions[0]
  const choices = base.choices.map((choice, i) => ({
    ...choice,
    outcome: priorities.includes(choice.id)
      ? reviewedRow(actions[i])
      : choice.outcome.replace(" | BEST | ", " | OTHER | ")
  }))
  const description =
    tieRefinement.kind === "exact"
      ? "exact terminal margins"
      : `${tieRefinement.horizon} complete turns (bounded preview)`
  const review = `TIE REVIEW: Only earlier tied AI pits ${priorities.map((p) => p - 6).join(", ")} were compared using ${description}. Other actions retain their earlier ${baseTurns}-turn evaluation and were not re-ranked on this deeper scale. BEST marks the updated preferred group. Capture exposure on reviewed rows uses that row's own reviewed continuation.`
  const report = { ...base.report, actions, preferredActions }
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    report,
    priorityPits: moves.filter((p) => preferred.has(p)),
    recommendedAction,
    tieRefinement,
    ...(tieRefinement.kind === "exact"
      ? { endgame: tieRefinement.endgame }
      : {}),
    prompt: [
      `KALAH. AI to move. Current stores: AI ${report.stores.AI}; opponent ${report.stores.opponent}.`,
      review,
      "INDEPENDENT LEGAL AI ACTIONS:",
      ...choices.map((c) => c.outcome),
      `RECOMMENDED AI ACTION: ${JSON.stringify(recommendedAction)}`
    ].join("\n")
  }
}
