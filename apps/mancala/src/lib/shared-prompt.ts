import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { buildMovePrompt as buildHistorical } from "./shared-prompt-v11.ts"
import type { PromptInput as HistoricalInput } from "./shared-prompt-v11.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v11.ts"
export type {
  MoveAnalysis,
  EngineReport,
  EngineAction
} from "./shared-prompt-v11.ts"
export const SHARED_PROMPT_VERSION = "shared-v12" as const
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
  "shared-v11",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<HistoricalInput, "version"> & {
  version: PromptVersion
  recommendedAction?: string
}
export const SHARED_SYSTEM_PROMPT = [
  "You control the AI in Kalah. Human is the opponent. AI WIN is good; DRAW beats AI DEFEAT. All listed actions are legal, but legality does not mean they are equally good.",
  "The engine report ends with RECOMMENDED AI ACTION. It is a legal representative from the best evaluated group; equally preferred ties have already been resolved, preferring an immediate terminal draw when every preferred action is proved to draw. Select that recommended action and copy its complete label into the pit value of your JSON answer. The other legal actions remain in the schema for validation and comparison, not as recommendations.",
  "The table explains the decision using captures, bonus sows, checked margins and proved results. A proved AI defeat cannot be rescued by zero capture exposure. Bounded scores are previews rather than eventual results. Do not confuse an opponent reply with your action, or choose a larger starting pit instead of the recommendation.",
  "If the report says no recommendation was verified, choose a legal action using the supplied incomplete facts without inventing certainty. Return only the JSON object."
].join("\n\n")
/** Make v10's first-preferred tie policy explicit data, without narrowing legal outputs. */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION
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
      version === "shared-v10" ||
      version === "shared-v11"
    )
      return buildHistorical(game, moves, version)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildHistorical(game, moves, "shared-v10")
  const preferredLabels = base.report?.preferredActions ?? []
  const preferredActions =
    base.report?.actions.filter((action) =>
      preferredLabels.includes(action.label)
    ) ?? []
  const terminalDraw =
    preferredActions.length > 0 &&
    preferredActions.every((action) => action.resultForAI === "DRAW")
      ? preferredActions.find((action) => action.now.endsGame)?.label
      : undefined
  const recommendedAction = terminalDraw ?? preferredLabels[0]
  const prompt = base.prompt
    .split("\n")
    .map((line) =>
      line.startsWith("PREFERRED AI ACTION LABELS:")
        ? recommendedAction
          ? `RECOMMENDED AI ACTION: ${JSON.stringify(recommendedAction)}`
          : "No recommendation was verified; evaluation is incomplete."
        : line
    )
    .join("\n")
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    prompt,
    recommendedAction
  }
}
