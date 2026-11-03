import { annotatedLegalMoves, currentThreats } from "./chess.ts"
import type { Game } from "./chess.ts"
import { buildSharedPrompt } from "./shared-prompt.ts"
import { stableMoveOrder } from "./move-order.ts"

export type AnalysisRequest = {
  game: Game
  moveOrder?: readonly string[]
  moveOrderSeed?: string
}
export type AnalysisInput = ReturnType<typeof buildSharedPrompt>

/** Production annotations and prompt assembly, run off the UI thread. */
export function buildMoveAnalysis({ game, moveOrder, moveOrderSeed }: AnalysisRequest): AnalysisInput {
  let moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    support: game.board.some(piece => piece?.side === game.turn && (piece.type === "q" || piece.type === "r")),
    castling: /[kq]/.test(game.fen.split(" ")[2]),
    kingCover: true,
    promotionReplies: true,
    kingMobility: true,
    safety: true
  })
  if (!moves.length) throw new Error("The AI has no legal moves.")
  if (moveOrder) {
    const rank = new Map(moveOrder.map((id, index) => [id, index]))
    if (moveOrder.length !== moves.length || rank.size !== moves.length || moves.some(move => !rank.has(move.id)))
      throw new Error("Benchmark move order does not match the position's legal choices.")
    moves.sort((left, right) => rank.get(left.id)! - rank.get(right.id)!)
  } else moves = stableMoveOrder(moves, moveOrderSeed ?? game.sessionId)
  return buildSharedPrompt({ game, moves, currentThreats: currentThreats(game) })
}
