import { legalMoves, sow } from "./mancala.ts"
import type { Game, Side } from "./mancala.ts"
import {
  analyzeTacticalMoves,
  TACTICAL_OUTCOME_VERSION
} from "./move-outcomes.ts"
import type { TacticalMoveOutcome } from "./move-outcomes.ts"
import { buildMovePrompt as buildBaseline } from "./shared-prompt-v1.ts"
import type {
  MoveAnalysis as BaselineAnalysis,
  PromptInput as BaselineInput
} from "./shared-prompt-v1.ts"

export const SHARED_PROMPT_VERSION = "shared-v2" as const
export const PROMPT_VERSIONS = ["shared-v1", SHARED_PROMPT_VERSION] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export type MoveAnalysis = Omit<
  BaselineAnalysis,
  "checkedScore" | "humanCanWinNext" | "maxHumanCaptureNext"
> & {
  checkedScore: number | null
  humanCanWinNext: boolean | null
  maxHumanCaptureNext: number | null
  tactical?: TacticalMoveOutcome
}
export type PromptInput = Omit<BaselineInput, "version" | "analysis"> & {
  version: PromptVersion
  outcomeVersion?: string
  analysis: MoveAnalysis[]
  priorityPits?: number[]
}
export const SHARED_SYSTEM_PROMPT = [
  "Play the AI side in Kalah. Choose one supplied legal pit. Use the verified outcomes; card order is not a ranking. Each card is a separate alternative. Never combine its board or continuation with another card.",
  "Take a proved win; otherwise avoid a proved Human win. Choose from CHECKED PRIORITY CHOICES when listed. Those choices maximize the worst checked outcome AFTER both players finish their turns, including every bonus sow. Do not leave that group to chase an immediate capture or another turn. Use strategic judgment to break ties within it.",
  "A steal takes seeds from the opposite pit plus the landing seed. DANGER names an actual Human sequence, its landing pit, and the AI stash stolen. A bonus can let Human create an empty landing pit and steal later in the SAME turn. Large exposed stashes matter; a capture is useful only after weighing the best Human reply and your counterplay. A listed possible steal is exposure, not necessarily a forced net loss. STEAL-SAFE means no capture in the checked Human turn, not permanent safety.",
  "Whole-turn minimax checks the same number of completed turns for every card: AI, Human, AI response, then Human when four turns are checked. Bonus sows do not consume a turn. Scores use AI store minus Human store; a proved win adds 1000, a proved loss subtracts 1000. More than 24 secured seeds guarantees a win. Final sweeps are included. A bounded store margin is not an eventual win. When analysis is incomplete, do not treat missing threats as safe or partial scores as comparable.",
  "Immediate bonuses, captures, empty landing-pit setups, and flexibility are tie-breakers only. Seeds still in pits are unsecured. Do not prefer a full pit, an empty pit, or a bonus universally. Sow counterclockwise, include your store, skip theirs; capture only when the final seed lands in your own empty pit with seeds opposite. When either row empties, each player sweeps their remaining seeds into their own store."
].join("\n\n")

const label = (pit: number, side: Side = "ai") =>
  String(side === "ai" ? pit - 6 : pit + 1)
const path = (pits: number[], side: Side) =>
  pits
    .map((pit) => `${side === "ai" ? "AI" : "Human"} ${label(pit, side)}`)
    .join(" > ")
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`

/** Advice is explicit, but every legal move remains available to the model. */
export function checkedPriorityChoices(
  outcomes: readonly TacticalMoveOutcome[]
): number[] {
  if (
    !outcomes.length ||
    outcomes.some((move) => !move.complete || move.checkedScore === null)
  )
    return []
  const wins = outcomes.filter((move) => move.guaranteedOutcome === "ai-win")
  const defensible = outcomes.filter(
    (move) => move.guaranteedOutcome !== "human-win"
  )
  const candidates = wins.length
    ? wins
    : defensible.length
      ? defensible
      : outcomes
  const best = Math.max(
    ...candidates.map((move) => move.checkedScore ?? -Infinity)
  )
  return candidates
    .filter((move) => move.checkedScore === best)
    .map((move) => move.pit)
}

export function analyzeMoves(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai")
): MoveAnalysis[] {
  const outcomes = analyzeTacticalMoves(game, moves)
  return outcomes.map((tactical) => ({
    pit: tactical.pit,
    captured: tactical.captured,
    extraTurn: tactical.extraTurn,
    immediateStatus: tactical.immediateStatus,
    storeGain: tactical.storeGain,
    checkedScore: tactical.checkedScore,
    principalLine: tactical.principalLine,
    humanCanWinNext: tactical.humanCanWinNext,
    maxHumanCaptureNext: tactical.maxHumanCapture,
    nodes: tactical.nodes,
    tactical
  }))
}

function endOwnTurn(game: Game, outcome: TacticalMoveOutcome) {
  let end = sow(game.board, "ai", outcome.pit)
  if (outcome.complete)
    for (const pit of outcome.bestAiTurn.slice(1))
      end = sow(end.board, "ai", pit)
  return end
}

function describeOutcome(
  game: Game,
  outcome: TacticalMoveOutcome,
  priority: ReadonlySet<number>
): string {
  const first = sow(game.board, "ai", outcome.pit)
  const immediate = `capture ${outcome.captured}; store +${outcome.storeGain}; ${outcome.extraTurn ? "BONUS: AI moves again" : outcome.immediateStatus === "playing" ? "Human next" : `FINISHED ${outcome.immediateStatus}, final AI ${first.board[13]} / Human ${first.board[6]}`}`
  const checked =
    outcome.complete && outcome.checkedScore !== null
      ? `Checked score ${signed(outcome.checkedScore)} after ${outcome.completeTurnsChecked} complete turns${outcome.guaranteedOutcome ? `; PROVED ${outcome.guaranteedOutcome}` : " (bounded store preview)"}.`
      : "Whole-turn score INCOMPLETE; no safety or priority inference from missing branches."
  const own = outcome.complete
    ? `Own complete turn ${path(outcome.bestAiTurn, "ai")}: store +${outcome.aiTurnStoreGain}, captures ${outcome.aiTurnCapture}.`
    : "Own complete continuation not fully checked."
  const hasHumanReply = endOwnTurn(game, outcome).status === "playing"
  const conditional =
    outcome.bestAiTurn.length > 1 ? "After that AI bonus continuation, " : ""
  let risk = !hasHumanReply
    ? "No Human reply: this AI turn ends the game."
    : outcome.safetyChecked
      ? outcome.maxHumanTurnCapture === 0
        ? `${conditional}STEAL-SAFE for the complete Human reply.`
        : `${conditional}Human can capture up to ${outcome.maxHumanTurnCapture} total seeds in one turn.`
      : "Human steal scan INCOMPLETE: missing threats are unknown."
  if (outcome.humanSteal) {
    const steal = outcome.humanSteal
    risk += ` DANGER ${path(steal.path, "human")}: ${steal.captures.map((capture) => `lands Human ${label(capture.landingPit, "human")}, steals ${capture.stolenSeeds} from AI pit ${label(capture.targetPit)} + 1 landing seed = ${capture.captured}`).join("; ")}.`
    if (!outcome.safetyChecked)
      risk += " This is an observed possible steal, not an exhaustive maximum."
  }
  if (outcome.humanCanWinNext === true)
    risk += " Human has a winning full-turn reply."
  const response = outcome.bestAiResponse.length
    ? `Separate worst-net line: ${path(outcome.worstHumanReply, "human")}; after THAT reply, ${path(outcome.bestAiResponse, "ai")}.`
    : ""
  return `Pit ${label(outcome.pit)} | ${priority.has(outcome.pit) ? "CHECKED PRIORITY; " : ""}${game.board[outcome.pit]} seeds; ${immediate}. ${checked} ${own} ${risk} ${response}`.trim()
}

export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION
): PromptInput {
  if (version === "shared-v1") return buildBaseline(game, moves)
  if (version !== SHARED_PROMPT_VERSION)
    throw new Error("Unsupported prompt version.")
  const analysis = analyzeMoves(game, moves)
  const outcomes = analysis.flatMap((move) =>
    move.tactical ? [move.tactical] : []
  )
  const priorityPits = checkedPriorityChoices(outcomes)
  const priority = new Set(priorityPits)
  const safe = outcomes.filter(
    (move) =>
      move.safetyChecked &&
      move.maxHumanTurnCapture === 0 &&
      endOwnTurn(game, move).status === "playing"
  )
  const choices = outcomes.map((move) => ({
    id: move.pit,
    label: label(move.pit),
    outcome: describeOutcome(game, move, priority)
  }))
  const facts = [
    ...(priorityPits.length
      ? [
          `CHECKED PRIORITY CHOICES: ${priorityPits.map((pit) => `Pit ${label(pit)}`).join(", ")}. Choose from these; use other hints only to break ties.`
        ]
      : [
          "Whole-turn choices are not all comparable. No priority group is asserted."
        ]),
    ...(safe.length
      ? [
          `STEAL-SAFE COMPLETE REPLIES: ${safe.map((move) => `Pit ${label(move.pit)}${move.bestAiTurn.length > 1 ? ` following ${path(move.bestAiTurn, "ai")}` : ""}`).join("; ")}. Capture safety alone does not override a higher checked net.`
        ]
      : [])
  ]
  return {
    version,
    outcomeVersion: TACTICAL_OUTCOME_VERSION,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    analysis,
    priorityPits,
    prompt: [
      "AI to move. Your pits 1..6 are in sowing order, NOT left-to-right screen order. Human labels are also in its sowing order. A path is a legal sequence by the named side, including its bonus sows.",
      `BOARD NOW: AI pits [${game.board.slice(7, 13)}], store ${game.board[13]}; Human pits [${game.board.slice(0, 6)}], store ${game.board[6]}.`,
      ...facts,
      "ALL LEGAL CHOICES (independent alternatives):",
      ...choices.map((choice) => choice.outcome),
      `Return exactly one JSON object with key "pit" and its quoted legal label: ${choices.map((choice) => JSON.stringify(choice.label)).join(", ")}.`
    ].join("\n")
  }
}
