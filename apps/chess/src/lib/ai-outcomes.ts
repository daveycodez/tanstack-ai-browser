import { squareName } from "./chess.ts"
import type { AnnotatedMove, PieceType, Side } from "./chess.ts"

const names: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
}
const values: Record<PieceType, number | null> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: null
}
/** One concise, factual outcome line per move; order never ranks the choices. */
export function formatMoveOutcome(
  move: AnnotatedMove,
  side: Side,
  queenValue = 9
): string {
  const valueOf = (type: PieceType) =>
    type === "q" ? queenValue : values[type]
  const namedValue = (type: PieceType) =>
    `${names[type]} (${valueOf(type) ?? "royal"})`
  const opponent = side === "ai" ? "white" : "black"
  const facts: string[] = []
  if (move.captured) {
    const captureSquare = move.captures[0]
    const enPassant =
      captureSquare !== undefined && captureSquare !== move.path[1]
    facts.push(
      `captures ${opponent} ${namedValue(move.captured)}${enPassant ? ` en passant on ${squareName(captureSquare)}` : ""}`
    )
  }
  if (move.notation.startsWith("O-O-O")) facts.push("castles queenside")
  else if (move.notation.startsWith("O-O")) facts.push("castles kingside")
  if (move.promotion) facts.push(`promotes to ${namedValue(move.promotion)}`)
  if (move.outcome.checkmate) facts.push("CHECKMATE, wins immediately")
  else if (move.outcome.stalemate) facts.push("STALEMATE, draw")
  else if (move.outcome.drawReason)
    facts.push(`draw: ${move.outcome.drawReason}`)
  else if (move.outcome.check) facts.push("CHECK, opponent must respond")
  if (move.outcome.allowsMateInOne)
    facts.push("DANGER: opponent can CHECKMATE next turn")
  if (!facts.length) facts.push("quiet move")
  if (
    !move.outcome.checkmate &&
    !move.outcome.drawReason &&
    !move.outcome.stalemate
  ) {
    const { count, lowest } = move.outcome.recapture
    facts.push(
      `legal recapturers: ${count}${lowest ? `, cheapest ${opponent} ${namedValue(lowest.piece)} from ${squareName(lowest.square)}` : ""}`
    )
    if (count > 0 && valueOf(move.piece) !== null) {
      // Promotion gains cancel the promoted piece's loss if it is recaptured.
      const net =
        (move.captured ? (valueOf(move.captured) ?? 0) : 0) -
        (valueOf(move.piece) ?? 0)
      facts.push(`if recaptured: net material ${net > 0 ? "+" : ""}${net}`)
    }
  }
  return `${move.id}: ${names[move.piece]} ${squareName(move.path[0])}-${squareName(move.path[1])}; outcome: ${facts.join("; ")}`
}
