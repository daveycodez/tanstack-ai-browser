import { squareName } from "./chess.ts"
import type { AnnotatedMove, PieceType } from "./chess.ts"

const names: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
}
const values: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
type LabelMove = Pick<
  AnnotatedMove,
  "id" | "piece" | "captured" | "path" | "captures" | "promotion" | "notation"
>

/** A literal action label: no check symbols, ranking, or safety assessment. */
export function moveChoiceLabel(move: LabelMove): string {
  const from = squareName(move.path[0]),
    to = squareName(move.path[1])
  let label = move.notation.startsWith("O-O")
    ? `Castle ${move.notation.startsWith("O-O-O") ? "queenside" : "kingside"}: king ${from} to ${to}`
    : move.captured
      ? `Capture ${names[move.captured]} (${values[move.captured]}): ${names[move.piece]} ${from} to ${to}`
      : `Move ${names[move.piece]} ${from} to ${to}`
  if (move.promotion) label += `; promote to ${names[move.promotion]}`
  const capturedSquare = move.captures[0]
  if (
    move.captured &&
    capturedSquare !== undefined &&
    capturedSquare !== move.path[1]
  )
    label += `; en passant pawn on ${squareName(capturedSquare)}`
  return label
}

/** Resolve only an exact supplied action label to its existing engine UCI ID. */
export function resolveActionLabel(
  moves: readonly AnnotatedMove[],
  answer: string
): string {
  const byLabel = new Map(moves.map((move) => [moveChoiceLabel(move), move.id]))
  if (byLabel.size !== moves.length)
    throw new Error("Move choice labels must be unique.")
  const id = byLabel.get(answer)
  if (!id)
    throw new Error(
      `The AI chose a noncanonical or illegal action label: ${answer.slice(0, 80)}`
    )
  return id
}
