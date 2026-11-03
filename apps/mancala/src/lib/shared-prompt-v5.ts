import { legalMoves, sow } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import type { TacticalMoveOutcome } from "./move-outcomes.ts"
import { buildMovePrompt as buildV4 } from "./shared-prompt-v4.ts"
import type { PromptInput as V4Input } from "./shared-prompt-v4.ts"
import { checkedPriorityChoices as previousPriorityChoices } from "./shared-prompt-v4.ts"
export { analyzeMoves } from "./shared-prompt-v4.ts"
export type { MoveAnalysis } from "./shared-prompt-v4.ts"
export const SHARED_PROMPT_VERSION = "shared-v5" as const
export const PROMPT_VERSIONS = [
  "shared-v1",
  "shared-v2",
  "shared-v3",
  "shared-v4",
  SHARED_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type PromptInput = Omit<V4Input, "version"> & { version: PromptVersion }
export const SHARED_SYSTEM_PROMPT = [
  "Play AI in Kalah. Return one supplied AI action by copying its full literal label. Never return a Human reply or a bare pit number. Card order is not a ranking.",
  "Finish an available win NOW. Otherwise choose from CHECKED PRIORITY ACTIONS. Their checked net is already computed across complete turns and best counterplay. Equal checked nets are TIED within this horizon: do not recalculate or invent a different net from a bonus, capture, or example reply. Among tied priorities, prefer lower Human capture exposure, then more own-turn seeds secured; if those also tie, prefer a bonus sow. These are tie-breakers, not proof of a higher checked net.",
  "Each card is a separate alternative. Its planned AI follow-up explains the conditional Human exposure. A Human witness is one possible reply, not a continuation of another card and not necessarily the worst net. The supplied net already includes best AI counterplay; you do not need to reconstruct it from example paths. STEAL-SAFE means no capture during that checked Human turn only.",
  "Positive net favors AI; negative favors Human. A proved win adds 1000, a proved loss subtracts 1000. Other numbers are bounded margins, not full-game guarantees. Bonuses stay within a turn. Unfinished analysis gives no comparable priority or safety claim.",
  "Sow counterclockwise, include your store, skip theirs. Last seed in your store earns another sow. Last seed in your own empty pit captures the occupied opposite pit plus that seed. When a row empties, each side sweeps its remaining seeds to its store. More than 24 secured seeds wins."
].join("\n\n")
const own = (pits: number[]) =>
  `AI sows pit ${pits.map((pit) => pit - 6).join(", then pit ")}`
const human = (pits: number[]) =>
  `Human sows pit ${pits.map((pit) => pit + 1).join(", then pit ")}`
function card(
  game: Game,
  label: string,
  outcome: TacticalMoveOutcome,
  priority: boolean
): string {
  let end = sow(game.board, "ai", outcome.pit)
  if (outcome.complete)
    for (const pit of outcome.bestAiTurn.slice(1))
      end = sow(end.board, "ai", pit)
  const immediate =
    outcome.immediateStatus === "playing"
      ? `now capture ${outcome.captured}, store +${outcome.storeGain}, ${outcome.extraTurn ? "BONUS sow" : "handoff"}`
      : `FINISHED ${outcome.immediateStatus}, final stores AI ${end.board[13]}, Human ${end.board[6]}`
  const net = outcome.complete
    ? `Checked net ${outcome.checkedScore} after ${outcome.completeTurnsChecked} full turns${outcome.guaranteedOutcome ? `; PROVED ${outcome.guaranteedOutcome}` : " (bounded)"}. Planned own turn: ${own(outcome.bestAiTurn)}; secure +${outcome.aiTurnStoreGain}, captures ${outcome.aiTurnCapture}.`
    : "Whole-turn scan UNFINISHED; score and safe choices unknown."
  let risk =
    end.status !== "playing"
      ? "No Human reply: the AI turn ends the game."
      : !outcome.safetyChecked
        ? "Human capture scan UNFINISHED."
        : outcome.maxHumanTurnCapture === 0
          ? "STEAL-SAFE: Human capture exposure 0 for that full reply."
          : `After that own turn, Human capture exposure ${outcome.maxHumanTurnCapture} total seeds.`
  if (outcome.humanSteal)
    risk += ` DANGER witness: ${human(outcome.humanSteal.path)}; ${outcome.humanSteal.captures.map((c) => `lands Human pit ${c.landingPit + 1}, steals ${c.stolenSeeds} from AI pit ${c.targetPit - 6} plus 1 landing seed = ${c.captured}`).join("; ")}.`
  if (outcome.humanCanWinNext) risk += " Human has a winning full-turn reply."
  return `${label} | ${priority ? "CHECKED PRIORITY; " : ""}${immediate}. ${net} ${risk}`
}
export function checkedPriorityChoices(
  outcomes: readonly TacticalMoveOutcome[]
): number[] {
  const now = outcomes.filter((outcome) => outcome.immediateStatus === "ai-won")
  return now.length
    ? now.map((outcome) => outcome.pit)
    : previousPriorityChoices(outcomes)
}

/** Tightened using the LFM3 failure trace: no ambiguous arrows or redundant counter-lines. */
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
      version === "shared-v4"
    )
      return buildV4(game, moves, version)
    throw new Error("Unsupported prompt version.")
  }
  const base = buildV4(game, moves, "shared-v4"),
    priorities = new Set(base.priorityPits ?? [])
  const choices = base.choices.map((choice) => {
    const tactical = base.analysis.find(
      (move) => move.pit === choice.id
    )?.tactical
    if (!tactical)
      throw new Error("A current action requires verified tactical context.")
    return {
      ...choice,
      outcome: card(game, choice.label, tactical, priorities.has(choice.id))
    }
  })
  const names = choices
    .filter((choice) => priorities.has(choice.id))
    .map((choice) => JSON.stringify(choice.label))
  const priority = names.length
    ? `CHECKED PRIORITY ACTIONS: ${names.join("; ")}. Copy one exact label; apply the stated tie-breakers only within this group.`
    : "Whole-turn scan unfinished: no priority group is asserted."
  return {
    ...base,
    version,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    prompt: [
      `AI to move. Current stores: AI ${game.board[13]}, Human ${game.board[6]}.`,
      priority,
      "INDEPENDENT AI ACTIONS (all legal). Human witnesses are opponent replies only:",
      ...choices.map((choice) => choice.outcome),
      priority,
      'Return only JSON with key "pit" and the full selected AI label before |. The supplied checked nets are already evaluated; equal numbers stay tied.'
    ].join("\n")
  }
}
