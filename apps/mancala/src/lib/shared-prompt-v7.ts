import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV6,
  SHARED_SYSTEM_PROMPT as V6_SYSTEM
} from "./shared-prompt-v6.ts"
import type { PromptInput as V6Input } from "./shared-prompt-v6.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v6.ts"
export type { MoveAnalysis } from "./shared-prompt-v6.ts"
export const SHARED_PROMPT_VERSION = "shared-v7" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  "shared-v4",
  "shared-v5",
  "shared-v6",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V6Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT =
  V6_SYSTEM +
  "\n\nFor an EXACT ENDGAME COMPARISON, maximize the final AI store and final AI-minus-Human margin. Winning is not enough when another compared action wins by more. A positive final margin can still be INFERIOR. Final-score loss measures what that action gives up versus the best compared finish; choose a BEST COMPARED FINISH with zero loss. A card's best continuation is conditional on choosing that card, not a recommendation to choose it. These terminal figures outrank bonuses, sowed-seed counts, and short-horizon ties."

/** Clarify terminal comparisons without changing the solver, grading or legal choices. */
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
      version === "shared-v6"
    )
      return buildV6(game, moves, version)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV6(game, moves, "shared-v6")
  const endgame = base.endgame
  if (!endgame?.complete)
    return { ...base, version, systemPrompt: SHARED_SYSTEM_PROMPT }
  const bestMargin = Math.max(...endgame.moves.map((move) => move.finalMargin))
  const bestStore = Math.max(...endgame.moves.map((move) => move.aiStore))
  const solved = new Map(endgame.moves.map((move) => [move.pit, move]))
  const comparison: string[] = []
  const choices = base.choices.map((choice) => {
    const exact = solved.get(choice.id)
    if (!exact) return choice
    const lostMargin = bestMargin - exact.finalMargin,
      lostSeeds = bestStore - exact.aiStore
    const assessment =
      lostMargin === 0
        ? "BEST COMPARED FINISH; zero final-score loss"
        : `INFERIOR COMPARED FINISH; gives up ${lostSeeds} final AI seeds and ${lostMargin} points of final margin`
    const final = `AI ${exact.aiStore}, Human ${exact.humanStore}; final margin ${exact.finalMargin > 0 ? "+" : ""}${exact.finalMargin}`
    comparison.push(
      `${JSON.stringify(choice.label)} => ${final}. ${assessment}.`
    )
    const own = exact.bestAiTurn.map((pit) => pit - 6).join(", then pit ")
    return {
      ...choice,
      outcome: `${choice.label} | ${lostMargin === 0 ? "CHECKED PRIORITY; " : ""}${assessment}. EXACT FINAL MARGIN ${exact.finalMargin > 0 ? "+" : ""}${exact.finalMargin}; final stores AI ${exact.aiStore}, Human ${exact.humanStore} under best play by both sides. Conditional on choosing THIS action, its best AI continuation sows pit ${own}. This does not make an inferior action equally good.`
    }
  })
  const names = choices
    .filter((choice) => (base.priorityPits ?? []).includes(choice.id))
    .map((choice) => JSON.stringify(choice.label))
  const priority = `CHECKED PRIORITY ACTIONS: ${names.join("; ")}. Select a BEST COMPARED FINISH with zero final-score loss. Reject an INFERIOR COMPARED FINISH even if it still wins.`
  const cards = new Map(
    base.choices.map((old, index) => [old.outcome, choices[index].outcome])
  )
  const prompt = base.prompt
    .split("\n")
    .flatMap((line) => {
      if (line.startsWith("CHECKED PRIORITY ACTIONS:")) return [priority]
      if (line.startsWith("INDEPENDENT AI ACTIONS"))
        return [
          "EXACT ENDGAME COMPARISON (same starting board, best play by BOTH sides):",
          ...comparison,
          line
        ]
      return [cards.get(line) ?? line]
    })
    .join("\n")
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    prompt
  }
}
