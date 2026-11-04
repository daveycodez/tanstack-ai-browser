import { applyMove, legalMoves } from "../src/lib/checkers.ts"
import type { Board, Game, Move, Side } from "../src/lib/checkers.ts"

/** A small, conventional reference, not an expert engine or game-theoretic oracle. */
export const BEHAVIOR_ENGINE_VERSION = "alpha-beta-material-position-v1"
export const BEHAVIOR_EVALUATION = {
  piece: 100,
  king: 175,
  advancement: 3,
  ordinaryCenter: 1,
  kingCenter: 2,
  backRowGuard: 4,
  mobility: 2,
  terminal: 1_000_000
} as const
export type BehaviorEngineOptions = { depth?: number }
export type BehaviorMoveScore = { id: string; score: number; rank: number; regret: number }
export type BehaviorEvaluation = {
  evaluationVersion: typeof BEHAVIOR_ENGINE_VERSION
  depth: number
  side: Side
  /** AI-centric centipiece units; ranks and regrets are relative to the current actor. */
  score: number
  moves: BehaviorMoveScore[]
  bestMoveIds: string[]
  nodes: number
  leafNodes: number
  quiescenceNodes: number
}
const canonical = (moves: readonly Move[]) => [...moves].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Material, development, centrality, back-row cover and legal mobility only. */
export function evaluateBehaviorBoard(board: Board): number {
  const weights = BEHAVIOR_EVALUATION
  let value = 0
  for (let square = 0; square < board.length; square++) {
    const piece = board[square]
    if (!piece) continue
    const row = Math.floor(square / 8), column = square % 8
    const center = Math.min(row, 7 - row) + Math.min(column, 7 - column)
    const advancement = piece.side === "ai" ? row : 7 - row
    const development = piece.king
      ? weights.king + center * weights.kingCenter
      : weights.piece + advancement * weights.advancement + center * weights.ordinaryCenter
        + (advancement === 0 ? weights.backRowGuard : 0)
    value += (piece.side === "ai" ? 1 : -1) * development
  }
  return value + weights.mobility * (legalMoves(board, "ai").length - legalMoves(board, "human").length)
}

/**
 * Fixed-depth alpha-beta over complete legal turns. At the horizon, compulsory
 * captures continue until quiet or terminal; each such turn removes a piece.
 * No randomness, wall-clock limit, node cap, or app recommendation is used.
 * No transposition shortcuts drop repetition history or the quiet clock.
 */
export function evaluateBehaviorPosition(game: Game, options: BehaviorEngineOptions = {}): BehaviorEvaluation {
  const depth = options.depth ?? 4
  if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError("Reference depth must be a positive safe integer.")
  let nodes = 0, leafNodes = 0, quiescenceNodes = 0
  const terminal = (position: Game, ply: number): number | undefined => position.status === "ai-won"
    ? BEHAVIOR_EVALUATION.terminal - ply
    : position.status === "human-won" ? -BEHAVIOR_EVALUATION.terminal + ply
      : position.status === "draw" ? 0 : undefined
  const search = (position: Game, remaining: number, ply: number, alpha: number, beta: number): number => {
    nodes++
    const finished = terminal(position, ply)
    if (finished !== undefined) { leafNodes++; return finished }
    const moves = canonical(legalMoves(position.board, position.turn))
    if (!moves.length) {
      leafNodes++
      return position.turn === "ai" ? -BEHAVIOR_EVALUATION.terminal + ply : BEHAVIOR_EVALUATION.terminal - ply
    }
    if (remaining === 0 && !moves[0].captures.length) { leafNodes++; return evaluateBehaviorBoard(position.board) }
    if (remaining === 0) quiescenceNodes++
    let best = position.turn === "ai" ? -Infinity : Infinity
    for (const move of moves) {
      const value = search(applyMove(position, move.id), Math.max(0, remaining - 1), ply + 1, alpha, beta)
      if (position.turn === "ai") { best = Math.max(best, value); alpha = Math.max(alpha, best) }
      else { best = Math.min(best, value); beta = Math.min(beta, best) }
      if (alpha >= beta) break
    }
    return best
  }
  const finished = terminal(game, 0)
  const moves = finished === undefined ? canonical(legalMoves(game.board, game.turn)) : []
  const rootScores = moves.map(move => ({ id: move.id,
    // A full window for EACH root action gives real scores for every rank, not
    // alpha-beta bounds from sharing the current best root action's window.
    score: search(applyMove(game, move.id), depth - 1, 1, -Infinity, Infinity)
  }))
  if (!rootScores.length) {
    const score = finished ?? (game.turn === "ai" ? -BEHAVIOR_EVALUATION.terminal : BEHAVIOR_EVALUATION.terminal)
    return { evaluationVersion: BEHAVIOR_ENGINE_VERSION, depth, side: game.turn, score, moves: [], bestMoveIds: [], nodes: 1, leafNodes: 1, quiescenceNodes: 0 }
  }
  const score = game.turn === "ai" ? Math.max(...rootScores.map(move => move.score)) : Math.min(...rootScores.map(move => move.score))
  const values = [...new Set(rootScores.map(move => move.score))].sort((a, b) => game.turn === "ai" ? b - a : a - b)
  return {
    evaluationVersion: BEHAVIOR_ENGINE_VERSION, depth, side: game.turn, score,
    moves: rootScores.map(move => ({ ...move, rank: values.indexOf(move.score) + 1, regret: game.turn === "ai" ? score - move.score : move.score - score })),
    bestMoveIds: rootScores.filter(move => move.score === score).map(move => move.id), nodes, leafNodes, quiescenceNodes
  }
}

/** The canonical first tied optimum makes the comparator repeatable. */
export function chooseBehaviorMove(game: Game, options: BehaviorEngineOptions = {}): string | undefined {
  return evaluateBehaviorPosition(game, options).bestMoveIds[0]
}
