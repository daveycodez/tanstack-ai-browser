import type { EndgameTieSolver } from "./endgame-ties.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV10,
  SHARED_SYSTEM_PROMPT as V10_SYSTEM
} from "./shared-prompt-v10.ts"
import type { PromptInput as V10Input } from "./shared-prompt-v10.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v10.ts"
export type {
  MoveAnalysis,
  EngineReport,
  EngineAction
} from "./shared-prompt-v10.ts"
export const SHARED_PROMPT_VERSION = "shared-v11" as const
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
  "shared-v10",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V10Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT =
  V10_SYSTEM +
  "\n\nCapture or bonus wording inside an action label describes that action's verified immediate effect. It does not guarantee a safe or best full-game result. Use the preferred list to select, and copy that complete label exactly."
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
      version === "shared-v9" ||
      version === "shared-v10"
    )
      return buildV10(game, moves, version, endgameSolver)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV10(game, moves, "shared-v10", endgameSolver)
  const names = new Map(
    base.choices.map((choice) => {
      const t = base.analysis.find((move) => move.pit === choice.id)?.tactical
      if (!t)
        throw new Error(
          "Literal action labels require verified immediate outcomes."
        )
      const sowing = choice.label[0].toLowerCase() + choice.label.slice(1)
      const label = t.captured
        ? `Capture ${t.captured} seeds: ${sowing}`
        : t.extraTurn
          ? `Earn a bonus sow: ${sowing}`
          : choice.label
      return [choice.label, label]
    })
  )
  const choices = base.choices.map((choice) => {
    const label = names.get(choice.label) ?? choice.label
    return {
      ...choice,
      label,
      outcome: label + choice.outcome.slice(choice.label.length)
    }
  })
  const report = base.report
    ? {
        ...base.report,
        preferredActions: base.report.preferredActions.map(
          (label) => names.get(label) ?? label
        ),
        actions: base.report.actions.map((action) => ({
          ...action,
          label: names.get(action.label) ?? action.label
        }))
      }
    : undefined
  const rows = new Map(
    base.choices.map((choice, index) => [
      choice.outcome,
      choices[index].outcome
    ])
  )
  const prompt = base.prompt
    .split("\n")
    .map((line) =>
      line.startsWith("PREFERRED AI ACTION LABELS:")
        ? `PREFERRED AI ACTION LABELS: ${JSON.stringify(report?.preferredActions ?? [])}`
        : (rows.get(line) ?? line)
    )
    .join("\n")
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    report,
    choices,
    prompt
  }
}
