import type { EndgameTieSolver } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV5,
  SHARED_SYSTEM_PROMPT as V5_SYSTEM
} from "./shared-prompt-v5.ts"
import type { PromptInput as V5Input } from "./shared-prompt-v5.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import type { EndgameTieResult } from "./endgame-ties.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v5.ts"
export type { MoveAnalysis } from "./shared-prompt-v5.ts"
export const SHARED_PROMPT_VERSION = "shared-v6" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  "shared-v4",
  "shared-v5",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V5Input, "version"> & {
  version: PromptVersion
  endgame?: EndgameTieResult
}
export const SHARED_SYSTEM_PROMPT = V5_SYSTEM.replace(
  "Their checked net is already computed across complete turns and best counterplay.",
  "Their checked net is already computed across complete turns and best counterplay. For a solved endgame tie, EXACT FINAL MARGIN compares actual terminal scores under best play by both sides. Those figures replace the short-horizon tie: prefer the wider guaranteed winning margin, not merely any move that still wins. Only the named tie candidates have that terminal proof."
)

/** A bounded terminal solver separates small-endgame ties before asking the model. */
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
      version === "shared-v5"
    )
      return buildV5(game, moves, version)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV5(game, moves, "shared-v5")
  const immediateWin = base.analysis.some(
    (move) => move.immediateStatus === "ai-won"
  )
  const endgame = immediateWin
    ? undefined
    : endgameSolver(game, base.priorityPits ?? [])
  if (!endgame?.complete)
    return {
      ...base,
      version,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      ...(endgame ? { endgame } : {})
    }
  const priorities = new Set(endgame.bestPits)
  const solved = new Map(endgame.moves.map((move) => [move.pit, move]))
  const choices = base.choices.map((choice) => {
    const exact = solved.get(choice.id)
    if (!exact) return choice
    const own = exact.bestAiTurn.map((pit) => pit - 6).join(", then pit ")
    return {
      ...choice,
      outcome: `${choice.label} | ${priorities.has(choice.id) ? "CHECKED PRIORITY; " : ""}EXACT FINAL MARGIN ${exact.finalMargin > 0 ? "+" : ""}${exact.finalMargin}; final stores AI ${exact.aiStore}, Human ${exact.humanStore} under best play by both sides through the final sweep. The optimal AI turn starts with pit ${own}. This terminal proof replaces the earlier bounded tie and its illustrative continuation.`
    }
  })
  const names = choices
    .filter((choice) => priorities.has(choice.id))
    .map((choice) => JSON.stringify(choice.label))
  const priority = `CHECKED PRIORITY ACTIONS: ${names.join("; ")}. These have the best EXACT FINAL MARGIN among the previously tied candidates. A narrower forced win is still a worse final score.`
  const replacements = new Map(
    base.choices.map((choice, index) => [
      choice.outcome,
      choices[index].outcome
    ])
  )
  const prompt = base.prompt
    .split("\n")
    .map((line) =>
      line.startsWith("CHECKED PRIORITY ACTIONS:")
        ? priority
        : (replacements.get(line) ?? line)
    )
    .join("\n")
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    endgame,
    priorityPits: endgame.bestPits,
    choices,
    prompt
  }
}
