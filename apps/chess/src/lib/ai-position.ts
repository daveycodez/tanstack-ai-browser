import { squareName } from "./chess.ts"
import type { Game, PieceType, Side } from "./chess.ts"

const groups: [PieceType, string][] = [
  ["k", "King"],
  ["q", "Queens"],
  ["r", "Rooks"],
  ["b", "Bishops"],
  ["n", "Knights"],
  ["p", "Pawns"]
]

/** Decode the complete position before inference so the model can focus on moves. */
export function describePosition(game: Game): string {
  const [, , rights, enPassant, halfmove, fullmove] = game.fen.split(" ")
  const color = game.turn === "ai" ? "Black" : "White"
  function pieces(side: Side) {
    return groups.map(([type, label]) => {
      const squares = game.board.flatMap((piece, square) =>
        piece?.side === side && piece.type === type ? [squareName(square)] : []
      )
      return `${label}: ${squares.join(", ") || "none"}`
    })
  }
  function castling(king: string, queen: string) {
    const available = [
      rights.includes(king) && "kingside",
      rights.includes(queen) && "queenside"
    ].filter(Boolean)
    return available.join(" and ") || "none"
  }
  return [
    "Current board, already decoded into named pieces and exact squares:",
    "Black pieces (you):",
    ...pieces("ai"),
    "White pieces (opponent):",
    ...pieces("human"),
    `Side to move: ${color}.`,
    `${color} king is ${game.inCheck ? "in check" : "not in check"}.`,
    "Black pawns advance toward rank 1; White pawns advance toward rank 8.",
    `Black retains castling rights: ${castling("k", "q")}.`,
    `White retains castling rights: ${castling("K", "Q")}.`,
    "Castling rights do not bypass occupied squares or attacked king squares; only supplied moves are legal.",
    `En passant target square: ${enPassant === "-" ? "none" : enPassant}.`,
    `Half-moves since the last pawn move or capture: ${halfmove}. Full move number: ${fullmove}.`
  ].join("\n")
}
