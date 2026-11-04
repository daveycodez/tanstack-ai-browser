import type { EndgameTieSolver } from "./endgame-ties.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { buildMovePrompt as buildV8 } from "./shared-prompt-v8.ts"
import type { PromptInput as V8Input } from "./shared-prompt-v8.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v8.ts"
export type {
  MoveAnalysis,
  EngineReport,
  EngineAction
} from "./shared-prompt-v8.ts"
export const SHARED_PROMPT_VERSION = "shared-v9" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  "shared-v4",
  "shared-v5",
  "shared-v6",
  "shared-v7",
  "shared-v8",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V8Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT = [
  "You choose an AI move in Kalah, a seed-sowing game. Human is the opponent. Every result and margin is from YOUR AI side: AI WIN is good, AI LOSS is bad, and DRAW beats LOSS.",
  "The engine has evaluated all legal alternatives. Choose one label from PREFERRED AI ACTION LABELS at the end of the report whenever that list is nonempty. BEST marks that same preferred group. Other rows are legal but not recommended. The JSON schema lists all legal answers, not all good answers; do not mistake a losing legal option for a preferred option.",
  "The preferred group already accounts for winning now, proved results, scores, captures, bonus sows and final sweeps. Do not override it for a larger starting pit, immediate store gain or an opponent reply. Zero opponent capture does not guarantee avoiding defeat. Use other facts only to break ties within the preferred group. If the group is empty, unfinished analysis is unknown rather than safe.",
  "Return only a JSON object with key pit whose value is the exact full preferred AI action label."
].join("\n\n")
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
      version === "shared-v7" ||
      version === "shared-v8"
    )
      return buildV8(game, moves, version, endgameSolver)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV8(game, moves, "shared-v8", endgameSolver),
    report = base.report
  if (!report) throw new Error("A current prompt requires engine data.")
  const choices = base.choices.map((choice, index) => {
    const action = report.actions[index],
      e = action.evaluation
    const evaluation =
      e.kind === "EXACT_ENDGAME" || e.kind === "FINAL_NOW"
        ? `${e.kind === "FINAL_NOW" ? "finished now" : "exact final"} AI ${e.finalStores?.AI}, opponent ${e.finalStores?.opponent}, AI margin ${e.marginForAI}`
        : e.kind === "BOUNDED_TURNS"
          ? `${e.turns} complete turns, AI margin ${e.marginForAI} (bounded)`
          : "unfinished evaluation"
    return {
      ...choice,
      outcome: `${choice.label} | ${action.preferred ? "BEST" : "OTHER"} | AI ${action.resultForAI} | ${evaluation} | capture now ${action.now.capture}; store gain now ${action.now.storeGain}; bonus ${action.now.bonus ? "yes" : "no"}${action.opponentReply ? `; opponent capture exposure ${action.opponentReply.captureTotal ?? "unknown"}; opponent winning reply ${action.opponentReply.canWin === null ? "unknown" : action.opponentReply.canWin ? "yes" : "no"}` : ""}`
    }
  })
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    prompt: [
      `KALAH. AI to move. Current stores: AI ${report.stores.AI}; opponent ${report.stores.opponent}.`,
      "INDEPENDENT LEGAL AI ACTIONS:",
      ...choices.map((choice) => choice.outcome),
      `PREFERRED AI ACTION LABELS: ${JSON.stringify(report.preferredActions)}`
    ].join("\n")
  }
}
