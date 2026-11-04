import { buildMovePrompt as buildV16, PROMPT_VERSIONS as HISTORICAL_VERSIONS, SHARED_SYSTEM_PROMPT as SYSTEM_V16 } from "./shared-prompt-v16.ts"
import type { PromptInput as V16Input, PromptVersion as HistoricalVersion } from "./shared-prompt-v16.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import type { EndgameTieSolver } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v16.ts"
export type { MoveAnalysis, EngineAction, EngineReport } from "./shared-prompt-v16.ts"

export const PREVIOUS_PROMPT_VERSION = "shared-v16" as const
export const CONCISE_PROMPT_VERSION = "shared-v17" as const
export const SHARED_PROMPT_VERSION = CONCISE_PROMPT_VERSION
export const PROMPT_VERSIONS = [...HISTORICAL_VERSIONS, CONCISE_PROMPT_VERSION] as const
export type PromptVersion = typeof PROMPT_VERSIONS[number]
export type PromptInput = Omit<V16Input, "version"> & { version: PromptVersion }
export const CONCISE_SYSTEM_PROMPT = SYSTEM_V16
  .replace("by weighing its listed outcomes", "by weighing its outcomes")
  .replace("Your goal is to secure", "Secure")
  .replace("Each action is an independent alternative.", "Actions are independent alternatives.")
  .replace("not guarantees of the final result.", "not final guarantees.")
  .replace("and proved win/draw/loss outcomes", "and proved outcomes")
  .replace("when their evaluation kind", "when evaluation kind")
  .replace("; do not mix branches.", ".")
export const SHARED_SYSTEM_PROMPT = CONCISE_SYSTEM_PROMPT
function concise(text: string): string {
  return text
    .replaceAll("capture now ", "capture ")
    .replaceAll("store gain now ", "store gain ")
    .replace("KALAH. AI to move. Current stores:", "KALAH. AI to move. Stores:")
    .replace("INDEPENDENT LEGAL AI ACTIONS:", "LEGAL AI ACTIONS:")
}
/** Same v16 analysis/report/schema, with shorter model-visible wording only. */
export function buildMovePrompt(game: Game, moves: readonly number[] = legalMoves(game.board, "ai"), version: PromptVersion = SHARED_PROMPT_VERSION, endgameSolver: EndgameTieSolver = createEndgameTieRequest().solve): PromptInput {
  if (version !== CONCISE_PROMPT_VERSION) return buildV16(game, moves, version as HistoricalVersion, endgameSolver)
  const base = buildV16(game, moves, PREVIOUS_PROMPT_VERSION, endgameSolver)
  const rows = new Map<string, string>()
  const choices = base.choices.map(choice => { const outcome = concise(choice.outcome); rows.set(choice.outcome, outcome); return { ...choice, outcome } })
  return { ...base, version, systemPrompt: CONCISE_SYSTEM_PROMPT, choices, prompt: base.prompt.split("\n").map(line => rows.get(line) ?? concise(line)).join("\n") }
}
