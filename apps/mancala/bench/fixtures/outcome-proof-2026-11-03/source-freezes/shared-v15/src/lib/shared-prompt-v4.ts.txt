import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV3,
  SHARED_SYSTEM_PROMPT as V3_SYSTEM
} from "./shared-prompt-v3.ts"
import type { PromptInput as V3Input } from "./shared-prompt-v3.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v3.ts"
export type { MoveAnalysis } from "./shared-prompt-v3.ts"
export const SHARED_PROMPT_VERSION = "shared-v4" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V3Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT = V3_SYSTEM.replace(
  "Decision rule: choose one of CHECKED PRIORITY ACTIONS when supplied.",
  "Decision rule: finish an available win NOW before taking a bonus or a forecasted later win. A card saying FINISHED ai-won wins on this sow. Choose one of CHECKED PRIORITY ACTIONS when supplied."
).replace("More than24", "More than 24")

/** Preserve historical prompts; immediate wins lead the current priority policy. */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION
): PromptInput {
  if (
    version === "shared-v1" ||
    version === "shared-v2" ||
    version === "shared-v3"
  )
    return buildV3(game, moves, version)
  if (version !== SHARED_PROMPT_VERSION)
    throw new Error("Unsupported prompt version.")
  const base = buildV3(game, moves, "shared-v3")
  const immediateWins = base.analysis
    .filter((move) => move.immediateStatus === "ai-won")
    .map((move) => move.pit)
  const priorityPits = immediateWins.length
    ? immediateWins
    : (base.priorityPits ?? [])
  const priorities = new Set(priorityPits)
  const choices = base.choices.map((choice) => {
    const tail = choice.outcome
      .slice(choice.outcome.indexOf("|") + 1)
      .trim()
      .replace(/^CHECKED PRIORITY; /, "")
    return {
      ...choice,
      outcome: `${choice.label} | ${priorities.has(choice.id) ? "CHECKED PRIORITY; " : ""}${tail}`
    }
  })
  const names = choices
    .filter((choice) => priorities.has(choice.id))
    .map((choice) => choice.label)
  const priority = names.length
    ? `CHECKED PRIORITY ACTIONS: ${names.map((name) => JSON.stringify(name)).join("; ")}.${immediateWins.length ? " These WIN NOW; choose an immediate finish rather than another sow." : " Choose one of these exact AI action labels."}`
    : "Analysis is incomplete: no comparable priority group is asserted."
  const replacedCards = new Map(
    base.choices.map((old, index) => [old.outcome, choices[index].outcome])
  )
  const prompt = base.prompt
    .split("\n")
    .map((line) =>
      line.startsWith("CHECKED PRIORITY ACTIONS:") ||
      line.startsWith("Analysis is incomplete:")
        ? priority
        : (replacedCards.get(line) ?? line)
    )
    .join("\n")
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    priorityPits,
    choices,
    prompt
  }
}
