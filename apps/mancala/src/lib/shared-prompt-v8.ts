import type { EndgameTieSolver } from "./endgame-ties.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { legalMoves, sow } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { buildMovePrompt as buildV7 } from "./shared-prompt-v7.ts"
import type { PromptInput as V7Input } from "./shared-prompt-v7.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v7.ts"
export type { MoveAnalysis } from "./shared-prompt-v7.ts"
export const SHARED_PROMPT_VERSION = "shared-v8" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  "shared-v4",
  "shared-v5",
  "shared-v6",
  "shared-v7",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type ResultForAI = "WIN" | "DRAW" | "LOSS" | "UNPROVED"
export type EngineAction = {
  label: string
  preferred: boolean
  resultForAI: ResultForAI
  now: { capture: number; storeGain: number; bonus: boolean; endsGame: boolean }
  evaluation: {
    kind: "FINAL_NOW" | "EXACT_ENDGAME" | "BOUNDED_TURNS" | "INCOMPLETE"
    marginForAI: number | null
    turns?: number
    finalStores?: { AI: number; opponent: number }
    marginBelowBest?: number
    aiSeedsBelowBest?: number
    ownTurnPits?: number[]
  }
  ownTurn?: { pits: number[]; securedStoreGain: number; capture: number }
  opponentReply?: {
    fullyChecked: boolean
    captureTotal: number | null
    canWin: boolean | null
    witness?: {
      pits: number[]
      totalCaptured: number
      aiSeedsStolen: number
      captures: {
        landingOpponentPit: number
        targetAIPit: number
        aiSeedsStolen: number
        totalCaptured: number
      }[]
    }
  }
}
export type EngineReport = {
  you: "AI"
  opponent: "Human"
  sideToMove: "AI" | "opponent"
  stores: { AI: number; opponent: number }
  preferredActions: string[]
  actions: EngineAction[]
}
export type PromptInput = Omit<V7Input, "version"> & {
  version: PromptVersion
  report?: EngineReport
}
export const SHARED_SYSTEM_PROMPT = [
  "You control the AI side in Kalah, a seed-sowing game. Human is your opponent. Your goal is the best result FOR AI.",
  "The next message is an engine evaluation report. preferredActions lists the recommended labels; actions lists ALL legal alternatives. When preferredActions is nonempty, choose from that list. A legal action in the JSON schema is not necessarily a good action. Do not expand the preferred list or mistake an opponent reply for an AI action.",
  "Read resultForAI literally: WIN means AI wins, LOSS means the opponent wins, and DRAW is better than LOSS. UNPROVED means a bounded preview, not a proven game result. A larger marginForAI is better; a positive marginBelowBest means a worse margin within the stated evaluation. Never treat zero opponent captures as a guarantee against losing.",
  "The engine already accounts for captures, bonus sows, best replies and final sweeps. Exact endgame margins compare full finishes; bounded margins compare only the stated complete-turn horizon. Keep each action's plan and opponent witness separate. Do not recalculate scores or mix branches. When evaluation is incomplete, missing risk is unknown.",
  "Use tie-breakers only WITHIN preferredActions: lower opponent capture exposure, then more AI seeds secured, then a bonus sow. Return only JSON with key pit and the exact full action label."
].join("\n\n")

/** Instructions stay in system; the turn message is one data-only engine report. */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION,
  endgameSolver: EndgameTieSolver = createEndgameTieRequest().solve
): PromptInput {
  if (version !== SHARED_PROMPT_VERSION) {
    if (
      version === "shared-v1" ||
      version === "shared-v2" ||
      version === "shared-v3" ||
      version === "shared-v4" ||
      version === "shared-v5" ||
      version === "shared-v6" ||
      version === "shared-v7"
    )
      return buildV7(game, moves, version, endgameSolver)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV7(game, moves, "shared-v7", endgameSolver)
  const preferred = new Set(base.priorityPits ?? [])
  const tactical = base.analysis.flatMap((move) =>
    move.tactical ? [move.tactical] : []
  )
  const sameBoundedScale =
    !base.endgame?.complete &&
    tactical.length > 0 &&
    tactical.every(
      (move) =>
        move.complete &&
        move.checkedMargin !== null &&
        move.immediateStatus === "playing" &&
        !move.guaranteedOutcome &&
        move.completeTurnsChecked === tactical[0].completeTurnsChecked
    )
  const bestBounded = sameBoundedScale
    ? Math.max(...tactical.map((move) => move.checkedMargin ?? -Infinity))
    : undefined
  const exacts = new Map(
    base.endgame?.complete
      ? base.endgame.moves.map((move) => [move.pit, move])
      : []
  )
  const bestExactMargin = exacts.size
    ? Math.max(...[...exacts.values()].map((move) => move.finalMargin))
    : undefined
  const bestExactStore = exacts.size
    ? Math.max(...[...exacts.values()].map((move) => move.aiStore))
    : undefined
  const actions: EngineAction[] = base.choices.map((choice) => {
    const t = base.analysis.find((move) => move.pit === choice.id)?.tactical
    if (!t) throw new Error("A current action requires verified tactical data.")
    const exact = exacts.get(choice.id)
    const resultForAI: ResultForAI = exact
      ? exact.finalMargin > 0
        ? "WIN"
        : exact.finalMargin < 0
          ? "LOSS"
          : "DRAW"
      : t.immediateStatus === "ai-won" || t.guaranteedOutcome === "ai-win"
        ? "WIN"
        : t.immediateStatus === "human-won" ||
            t.guaranteedOutcome === "human-win"
          ? "LOSS"
          : t.immediateStatus === "draw"
            ? "DRAW"
            : "UNPROVED"
    let evaluation: EngineAction["evaluation"]
    if (exact) {
      evaluation = {
        kind: "EXACT_ENDGAME",
        marginForAI: exact.finalMargin,
        finalStores: { AI: exact.aiStore, opponent: exact.humanStore },
        marginBelowBest:
          (bestExactMargin ?? exact.finalMargin) - exact.finalMargin,
        aiSeedsBelowBest: (bestExactStore ?? exact.aiStore) - exact.aiStore,
        ownTurnPits: exact.bestAiTurn.map((pit) => pit - 6)
      }
    } else if (t.immediateStatus !== "playing") {
      const end = sow(game.board, "ai", choice.id)
      evaluation = {
        kind: "FINAL_NOW",
        marginForAI: end.board[13] - end.board[6],
        finalStores: { AI: end.board[13], opponent: end.board[6] }
      }
    } else
      evaluation = {
        kind: t.complete ? "BOUNDED_TURNS" : "INCOMPLETE",
        marginForAI: t.checkedMargin,
        turns: t.completeTurnsChecked,
        ...(bestBounded !== undefined && t.checkedMargin !== null
          ? { marginBelowBest: bestBounded - t.checkedMargin }
          : {})
      }
    const action: EngineAction = {
      label: choice.label,
      preferred: preferred.has(choice.id),
      resultForAI,
      now: {
        capture: t.captured,
        storeGain: t.storeGain,
        bonus: t.extraTurn,
        endsGame: t.immediateStatus !== "playing"
      },
      evaluation
    }
    if (!exact && t.immediateStatus === "playing") {
      action.ownTurn = {
        pits: t.bestAiTurn.map((pit) => pit - 6),
        securedStoreGain: t.aiTurnStoreGain,
        capture: t.aiTurnCapture
      }
      action.opponentReply = {
        fullyChecked: t.safetyChecked,
        captureTotal: t.maxHumanTurnCapture,
        canWin: t.humanCanWinNext,
        ...(t.humanSteal
          ? {
              witness: {
                pits: t.humanSteal.path.map((pit) => pit + 1),
                totalCaptured: t.humanSteal.totalCaptured,
                aiSeedsStolen: t.humanSteal.totalStolen,
                captures: t.humanSteal.captures.map((capture) => ({
                  landingOpponentPit: capture.landingPit + 1,
                  targetAIPit: capture.targetPit - 6,
                  aiSeedsStolen: capture.stolenSeeds,
                  totalCaptured: capture.captured
                }))
              }
            }
          : {})
      }
    }
    return action
  })
  const report: EngineReport = {
    you: "AI",
    opponent: "Human",
    sideToMove: game.turn === "ai" ? "AI" : "opponent",
    stores: { AI: game.board[13], opponent: game.board[6] },
    preferredActions: actions
      .filter((action) => action.preferred)
      .map((action) => action.label),
    actions
  }
  const choices = base.choices.map((choice, index) => ({
    ...choice,
    outcome: JSON.stringify(actions[index])
  }))
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    report,
    prompt: JSON.stringify(report, null, 2)
  }
}
