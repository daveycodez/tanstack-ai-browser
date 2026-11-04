import type { EndgameTieSolver } from "./endgame-ties.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV9,
  SHARED_SYSTEM_PROMPT as V9_SYSTEM
} from "./shared-prompt-v9.ts"
import type { PromptInput as V9Input } from "./shared-prompt-v9.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v9.ts"
export type {
  MoveAnalysis,
  EngineReport,
  EngineAction
} from "./shared-prompt-v9.ts"
export const SHARED_PROMPT_VERSION = "shared-v10" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  "shared-v4",
  "shared-v5",
  "shared-v6",
  "shared-v7",
  "shared-v8",
  "shared-v9",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V9Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT =
  V9_SYSTEM +
  "\n\nPROVED DEFEAT FOR YOU is a full-game result against best opposition, not a temporary negative score. A PROVED DRAW preserves a result better than defeat. Zero capture risk cannot rescue a proved defeat. When several preferred labels are listed, they are acceptable choices in the selected quality group: copy the FIRST label from PREFERRED AI ACTION LABELS. This means the first preferred label, never the first legal/schema/table label."
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
      version === "shared-v8" ||
      version === "shared-v9"
    )
      return buildV9(game, moves, version, endgameSolver)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV9(game, moves, "shared-v9", endgameSolver)
  const choices = base.choices.map((choice, index) => {
    const result = base.report?.actions[index].resultForAI
    const assessment =
      result === "LOSS"
        ? "PROVED DEFEAT FOR YOU"
        : result === "DRAW"
          ? "PROVED DRAW FOR YOU"
          : result === "WIN"
            ? "PROVED WIN FOR YOU"
            : "AI UNPROVED"
    const outcome = choice.outcome
      .replace(`AI ${result}`, assessment)
      .replace(/opponent winning reply yes/g, "AI-defeat reply exists yes")
      .replace(/opponent winning reply no/g, "AI-defeat reply exists no")
      .replace(
        /opponent winning reply unknown/g,
        "AI-defeat reply status unknown"
      )
    return { ...choice, outcome }
  })
  const changed = new Map(
    base.choices.map((choice, index) => [
      choice.outcome,
      choices[index].outcome
    ])
  )
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    prompt: base.prompt
      .split("\n")
      .map((line) => changed.get(line) ?? line)
      .join("\n")
  }
}
