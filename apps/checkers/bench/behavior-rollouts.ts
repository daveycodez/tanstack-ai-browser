import { applyMove, colorForSide, legalMoves, newGame } from "../src/lib/checkers.ts"
import type { Game, PieceColor, Side } from "../src/lib/checkers.ts"
import { chooseAiMove } from "../src/lib/ai.ts"
import { opponentOption } from "../src/lib/opponents.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import type { BehaviorReference } from "./behavior-reference.ts"

export const BEHAVIOR_ROLLOUT_PLIES = 20
export const BEHAVIOR_ROLLOUT_SEEDS = ["behavior-game-a", "behavior-game-b"] as const
export type BehaviorTraceMove = {
  ply: number; side: Side; color: PieceColor; moveId: string; legalChoices: number
  source: "model" | "reference" | "forced"; inferred: boolean
  quietReversal: boolean; referenceScore: number; referenceRegret: number; referenceRank: number
}
export type BehaviorTrace = {
  id: string; mode: "model" | "reference"; seed: string; humanColor: PieceColor
  initialTurn: Side; maxPlies: number; moves: BehaviorTraceMove[]
  status: Exclude<Game["status"], "playing"> | "capped" | "error" | "stopped"
  finalGame: Game; error?: string
  inferredAiTurns: number; forcedAiTurns: number
  quietReversals: { ai: number; human: number }
}
export type BehaviorTraceComparison = {
  firstDivergencePly: number | null; commonPrefixPlies: number
  identicalWithinWindow: boolean; unequalTraceLengths: boolean
}
export type BehaviorRolloutReport = {
  schemaVersion: 1; model: OpponentModel; referenceDepth: 4; maxPlies: number
  seeds: readonly string[]; thinking: false; sampling: "model defaults"; partial: boolean
  traces: BehaviorTrace[]
  comparisons: { humanColor: PieceColor; model: BehaviorTraceComparison; reference: BehaviorTraceComparison }[]
  notes: string[]
}
export function compareBehaviorTraces(a: Pick<BehaviorTrace, "moves">, b: Pick<BehaviorTrace, "moves">): BehaviorTraceComparison {
  const length = Math.min(a.moves.length, b.moves.length)
  let commonPrefixPlies = 0
  while (commonPrefixPlies < length && a.moves[commonPrefixPlies].side === b.moves[commonPrefixPlies].side && a.moves[commonPrefixPlies].moveId === b.moves[commonPrefixPlies].moveId) commonPrefixPlies++
  return { firstDivergencePly: commonPrefixPlies < length ? commonPrefixPlies + 1 : null,
    commonPrefixPlies, identicalWithinWindow: commonPrefixPlies === length && a.moves.length === b.moves.length,
    unequalTraceLengths: a.moves.length !== b.moves.length }
}

async function runTrace(options: {
  mode: BehaviorTrace["mode"]; model: OpponentModel; seed: string; humanColor: PieceColor
  signal: AbortSignal; reference: BehaviorReference; onProgress?: (message: string) => void
}): Promise<BehaviorTrace> {
  let game = newGame(options.humanColor)
  game.sessionId = `${options.seed}-${options.humanColor}`
  game.opponent = { model: options.model, thinking: false }
  const initialTurn = game.turn, moves: BehaviorTraceMove[] = []
  const controller = new AbortController(), abort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) abort()
  let errorText: string | undefined
  try {
    for (let ply = 1; ply <= BEHAVIOR_ROLLOUT_PLIES && game.status === "playing"; ply++) {
      options.signal.throwIfAborted()
      const side = game.turn, legal = legalMoves(game.board, side)
      if (!legal.length) throw new Error("A playing rollout position has no legal turn.")
      options.onProgress?.(`${options.mode === "model" ? "Model game" : "Reference control"} · ${options.humanColor} human · ${options.seed} · ply ${ply}/${BEHAVIOR_ROLLOUT_PLIES}`)
      const evaluation = await options.reference.evaluate(game, { depth: 4 })
      options.signal.throwIfAborted()
      const inferred = options.mode === "model" && side === "ai" && legal.length > 1
      const moveId = options.mode === "model" && side === "ai"
        ? await chooseAiMove(game, controller, phase => options.onProgress?.(`Model game · ${options.humanColor} human · ${options.seed} · ply ${ply}: ${phase}`))
        : evaluation.bestMoveIds[0]
      options.signal.throwIfAborted()
      if (!moveId || !legal.some(move => move.id === moveId)) throw new Error("A rollout policy returned no legal move.")
      const selected = legal.find(move => move.id === moveId)
      const scored = evaluation.moves.find(move => move.id === moveId)
      if (!selected || !scored) throw new Error("The reference did not score the selected rollout action.")
      const previous = [...game.history].reverse().find(move => move.side === side)
      const quietReversal = selected.captures.length === 0 && previous !== undefined && previous.captures.length === 0
        && selected.path[0] === previous.path.at(-1) && selected.path.at(-1) === previous.path[0]
      moves.push({ ply, side, color: colorForSide(game, side), moveId, legalChoices: legal.length,
        source: legal.length === 1 ? "forced" : inferred ? "model" : "reference", inferred,
        quietReversal, referenceScore: scored.score, referenceRegret: scored.regret, referenceRank: scored.rank })
      game = applyMove(game, moveId)
    }
  } catch (error) { errorText = error instanceof Error ? error.message : String(error) }
  finally { options.signal.removeEventListener("abort", abort) }
  return { id: `${options.mode}:${options.humanColor}:${options.seed}`, mode: options.mode, seed: options.seed,
    humanColor: options.humanColor, initialTurn, maxPlies: BEHAVIOR_ROLLOUT_PLIES, moves,
    status: options.signal.aborted ? "stopped" : errorText ? "error" : game.status === "playing" ? "capped" : game.status,
    finalGame: game, ...(errorText ? { error: errorText } : {}),
    inferredAiTurns: moves.filter(move => move.side === "ai" && move.inferred).length,
    forcedAiTurns: moves.filter(move => move.side === "ai" && move.source === "forced").length,
    quietReversals: { ai: moves.filter(move => move.side === "ai" && move.quietReversal).length, human: moves.filter(move => move.side === "human" && move.quietReversal).length } }
}

/** Production AI moves against a conventional deterministic opponent; no saved-game access. */
export async function runBehaviorRollouts(options: {
  model: OpponentModel; signal: AbortSignal; reference: BehaviorReference
  onProgress?: (message: string) => void; onTrace?: (trace: BehaviorTrace) => void
}): Promise<BehaviorRolloutReport> {
  if (opponentOption(options.model).thinking === "required") throw new Error("Behavioral evaluation requires a model that supports thinking off.")
  const traces: BehaviorTrace[] = []
  outer: for (const humanColor of ["white", "black"] as const) for (const seed of BEHAVIOR_ROLLOUT_SEEDS) {
    for (const mode of ["reference", "model"] as const) {
      if (options.signal.aborted) break outer
      const trace = await runTrace({ ...options, mode, seed, humanColor })
      traces.push(trace); options.onTrace?.(trace)
    }
  }
  const comparisons: BehaviorRolloutReport["comparisons"] = []
  for (const humanColor of ["white", "black"] as const) {
    const model = traces.filter(trace => trace.humanColor === humanColor && trace.mode === "model")
    const reference = traces.filter(trace => trace.humanColor === humanColor && trace.mode === "reference")
    if (model.length === 2 && reference.length === 2) comparisons.push({ humanColor,
      model: compareBehaviorTraces(model[0], model[1]), reference: compareBehaviorTraces(reference[0], reference[1]) })
  }
  return { schemaVersion: 1, model: options.model, referenceDepth: 4, maxPlies: BEHAVIOR_ROLLOUT_PLIES,
    seeds: BEHAVIOR_ROLLOUT_SEEDS, thinking: false, sampling: "model defaults",
    partial: options.signal.aborted || traces.length !== 8 || traces.some(trace => trace.status === "error" || trace.status === "stopped"),
    traces, comparisons,
    notes: ["These are 20-ply traces, not a full-match strength or Elo evaluation. Reaching the horizon is capped, never declared a draw.",
      "The two seeds change the production per-game legal-action ordering. Trace divergence combines that presentation variation with native model sampling.",
      "The reference ignores per-game presentation seeds. Quiet reversals are descriptive; a retreat may be correct. Human-likeness is not established by this test."] }
}
