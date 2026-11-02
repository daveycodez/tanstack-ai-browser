import type { Board, Piece } from "./checkers"

export type BoardStep = {
  from: number
  to: number
  piece: Piece
  captured?: number
  promotes: boolean
  board: Board
}

export const boardKey = (board: Board) => board.map(piece =>
  !piece ? "." : piece.side === "human" ? piece.king ? "H" : "h" : piece.king ? "A" : "a"
).join("")

/** Match a full turn or the remaining suffix of an in-progress human jump. */
export function boardSteps(from: Board, to: Board, path: number[]): BoardStep[] {
  if (boardKey(from) === boardKey(to)) return []
  for (let start = 0; start < path.length - 1; start++) {
    let board = from.slice()
    const steps: BoardStep[] = []
    for (let index = start; index < path.length - 1; index++) {
      const origin = path[index]
      const destination = path[index + 1]
      const piece = board[origin]
      if (!piece || board[destination]) break
      const dr = Math.floor(destination / 8) - Math.floor(origin / 8)
      const dc = destination % 8 - origin % 8
      if (Math.abs(dr) !== Math.abs(dc) || ![1, 2].includes(Math.abs(dr)) ||
        (!piece.king && Math.sign(dr) !== (piece.side === "human" ? -1 : 1))) break
      const captured = Math.abs(dr) === 2 ? (origin + destination) / 2 : undefined
      if (captured !== undefined && (!board[captured] || board[captured]?.side === piece.side)) break
      const promotes = !piece.king && Math.floor(destination / 8) === (piece.side === "human" ? 0 : 7)
      board = board.slice()
      board[origin] = null
      if (captured !== undefined) board[captured] = null
      board[destination] = { ...piece, king: piece.king || promotes }
      steps.push({ from: origin, to: destination, piece, captured, promotes, board })
    }
    if (steps.length === path.length - 1 - start && boardKey(board) === boardKey(to)) return steps
  }
  // A fresh game or a remote tab may skip several turns. Show that snapshot
  // directly instead of inventing a path between unrelated positions.
  return []
}
