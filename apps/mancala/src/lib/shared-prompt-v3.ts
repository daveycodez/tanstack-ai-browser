import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { buildMovePrompt as buildV2 } from "./shared-prompt-v2.ts"
import type { PromptInput as V2Input } from "./shared-prompt-v2.ts"
import { pitChoiceLabel } from "./move-choice.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v2.ts"
export type { MoveAnalysis } from "./shared-prompt-v2.ts"
export const SHARED_PROMPT_VERSION = "shared-v3" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V2Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT = [
  "Play the AI side of Kalah Mancala. Select one supplied AI action. Copy its entire literal action label, not a bare pit number or a Human reply.",
  "Decision rule: choose one of CHECKED PRIORITY ACTIONS when supplied. These maximize the worst checked net after complete turns, including bonuses, steals, counterplay and the final sweep. Do not override them for an immediate capture or extra turn. Use other facts only to break ties between priority actions. All legal actions stay in the output schema; their order is not a recommendation.",
  "Every card is a different possible board. Human sequences describe the opponent's possible replies, not actions you may select. DANGER names a real capture path and the AI stash it steals. A possible steal is exposure, not necessarily a forced net loss. A separate worst-net line has its own matching AI response; never combine branches.",
  "Positive checked net favors AI, negative favors Human. A proved win adds 1000 and a proved loss subtracts 1000; ordinary bounded margins do not prove eventual results. The horizon is the same number of completed turns for every action. Bonuses stay within a turn. Incomplete scores cannot form a priority group; missing threats are unknown. STEAL-SAFE refers only to the stated complete Human reply.",
  "Kalah: sow counterclockwise, include your store and skip theirs. Last seed in your store earns another sow. Last seed in your own empty pit captures the occupied opposite pit plus your landing seed. If either row empties, each side sweeps its remaining seeds to its own store. More than24 secured seeds wins."
].join("\n\n")
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION
): PromptInput {
  if (version === "shared-v1" || version === "shared-v2")
    return buildV2(game, moves, version)
  if (version !== SHARED_PROMPT_VERSION)
    throw new Error("Unsupported prompt version.")
  const base = buildV2(game, moves, "shared-v2")
  const names = new Map(
    base.choices.map((choice) => [
      choice.id,
      pitChoiceLabel(choice.id, game.board[choice.id])
    ])
  )
  const choices = base.choices.map((choice) => ({
    id: choice.id,
    label: names.get(choice.id) ?? "",
    outcome: `${names.get(choice.id)} | ${choice.outcome.slice(choice.outcome.indexOf("|") + 1).trim()}`
  }))
  const priorities = (base.priorityPits ?? [])
    .map((pit) => names.get(pit))
    .filter((name): name is string => name !== undefined)
  const priority = priorities.length
    ? `CHECKED PRIORITY ACTIONS: ${priorities.map((name) => JSON.stringify(name)).join("; ")}. Choose one of these exact AI action labels.`
    : "Analysis is incomplete: no comparable priority group is asserted."
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    prompt: [
      `AI to move. BOARD NOW: AI pits [${game.board.slice(7, 13)}], store ${game.board[13]}; Human pits [${game.board.slice(0, 6)}], store ${game.board[6]}.`,
      priority,
      "ALL LEGAL AI ACTIONS. Each label before | identifies that whole independent card. Human pit labels inside a card are opponent replies only:",
      ...choices.map((choice) => choice.outcome),
      priority,
      'Return only one JSON object with key "pit" and the complete selected AI action label before |. Copy the label exactly.'
    ].join("\n")
  }
}
