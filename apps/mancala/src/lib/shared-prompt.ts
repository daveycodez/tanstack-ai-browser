import type { EndgameTieSolver } from "./endgame-ties.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import {
  buildMovePrompt as buildV15,
  PROMPT_VERSIONS as HISTORICAL_VERSIONS
} from "./shared-prompt-v15.ts"
import type {
  PromptInput as V15Input,
  EngineAction as HistoricalAction,
  EngineReport as HistoricalReport
} from "./shared-prompt-v15.ts"
export { analyzeMoves, checkedPriorityChoices } from "./shared-prompt-v15.ts"
export type { MoveAnalysis } from "./shared-prompt-v15.ts"

export const SHARED_PROMPT_VERSION = "shared-v16" as const
export const PROMPT_VERSIONS = [...HISTORICAL_VERSIONS, SHARED_PROMPT_VERSION] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
// Historical versions retain their ranking fields; current reports omit them.
export type EngineAction = Omit<HistoricalAction, "preferred"> & { preferred?: boolean }
export type EngineReport = Omit<HistoricalReport, "actions" | "preferredActions" | "evaluationScope"> & {
  actions: EngineAction[]
  preferredActions?: string[]
  evaluationScope?: string
}
export type PromptInput = Omit<V15Input, "version" | "report"> & {
  version: PromptVersion
  report?: EngineReport
}

export const SHARED_SYSTEM_PROMPT = [
  "You control AI in Kalah. Human is the opponent. Choose one exact supplied legal action label by weighing its listed outcomes. Your goal is to secure the most seeds for AI. AI WIN is better than DRAW, and DRAW is better than AI LOSS.",
  "Each action is an independent alternative. Captures, store gains and bonus sows are immediate effects, not guarantees of the final result. Bonus sows belong to the same complete turn. Bounded margins cover only the stated turn horizon; exact final scores and proved win/draw/loss outcomes assume best play by both sides. Incomplete analysis is unknown. Compare numeric margins only when their evaluation kind and horizon match. Keep each action's plan and opponent reply separate; do not mix branches."
].join("\n\n")

function outcomeOnly(text: string): string {
  return text
    .replace(/ \| (?:BEST|OTHER) \| /g, " | ")
    .replace(/; final AI seeds below best(?: compared)? finish \d+/g, "")
    .replace(" | TIE REVIEW: ", " | ")
}
function neutralReport(source: HistoricalReport): EngineReport {
  const report: EngineReport = {
    ...source,
    actions: source.actions.map(action => {
      const next: EngineAction = { ...action, evaluation: { ...action.evaluation } }
      delete next.preferred
      delete next.evaluation.marginBelowBest
      delete next.evaluation.aiSeedsBelowBest
      return next
    })
  }
  delete report.preferredActions
  delete report.evaluationScope
  return report
}

/** Keep the existing per-action analysis and output contract; the model weighs
 * outcomes without a selected action, preferred group, or comparative rank.
 */
export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  version: PromptVersion = SHARED_PROMPT_VERSION,
  endgameSolver: EndgameTieSolver = createEndgameTieRequest().solve
): PromptInput {
  if (version !== SHARED_PROMPT_VERSION) return buildV15(game, moves, version, endgameSolver)
  const base = buildV15(game, moves, undefined, endgameSolver)
  const choices = base.choices.map(choice => ({ ...choice, outcome: outcomeOnly(choice.outcome) }))
  const rows = new Map(base.choices.map((choice, index) => [choice.outcome, choices[index].outcome]))
  const prompt = base.prompt.split("\n").flatMap(line => {
    if (/^(?:RECOMMENDED AI ACTION|PREFERRED AI ACTION LABELS):/.test(line)) return []
    if (line.startsWith("No recommendation was verified")) return ["Evaluation is incomplete; missing facts are unknown."]
    if (line.startsWith("TIE REVIEW:")) return ["Some actions include deeper analysis. Each row states its own horizon; numeric margins from different horizons are not directly comparable."]
    if (line.startsWith("ALL-ACTION ENDGAME REVIEW:")) return ["Every legal action has been evaluated through the final sweep under best play by both sides. Exact final seed scores are listed for each action."]
    if (line.startsWith("FULL-GAME OUTCOME REVIEW:")) return ["Every legal action has a proved AI outcome under best play, through a terminal finish or a secured majority. No exact final seed scores are claimed for these outcome classes."]
    return [rows.get(line) ?? line]
  }).join("\n")
  const input: PromptInput = {
    ...base, version, systemPrompt: SHARED_SYSTEM_PROMPT, prompt, choices,
    ...(base.report && { report: neutralReport(base.report) })
  }
  delete input.recommendedAction
  delete input.priorityPits
  return input
}
