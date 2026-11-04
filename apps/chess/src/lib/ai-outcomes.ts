import { squareName } from "./chess.ts"
import type { AnnotatedMove, PieceRef, PieceType, Side } from "./chess.ts"
import { BASE_CONTEXT_FEATURES } from "./context-options.ts"
import type { ContextFeatures } from "./context-options.ts"

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
  queenValue = 9,
  features: ContextFeatures = BASE_CONTEXT_FEATURES
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
  // The game is over: future support, mobility and castling facts no longer apply.
  if (
    move.outcome.checkmate ||
    move.outcome.stalemate ||
    move.outcome.drawReason
  ) {
    return `${move.id}: ${names[move.piece]} ${squareName(move.path[0])}-${squareName(move.path[1])}; outcome: ${facts.join("; ")}`
  }
  const pieceAt = (piece: PieceRef) =>
    `${names[piece.piece]}${valueOf(piece.piece) ?? "(royal)"}@${squareName(piece.square)}`
  const briefPieces = (pieces: PieceRef[]) =>
    `${pieces.slice(0, 2).map(pieceAt).join(", ")}${pieces.length > 2 ? ` +${pieces.length - 2} more` : ""}`
  const groups: string[][] = []
  const relationship = move.outcome.relationships
  let fullAttackerFact: string | undefined
  if (features.relationships && relationship) {
    const parts: string[] = []
    if (relationship.movedPieceThreatenedBy.length) {
      fullAttackerFact = `moved piece capturable by ${opponent} ${relationship.movedPieceThreatenedBy.map(pieceAt).join(", ")}`
      parts.push(fullAttackerFact)
    } else if (relationship.movedPieceWasThreatened) {
      parts.push("moved piece no longer legally capturable")
    }
    const threat = relationship.newThreats[0]
    if (threat)
      parts.push(
        `new threat on unchanged board: ${opponent} ${pieceAt(threat.target)} by ${briefPieces(threat.attackers)}`
      )
    if (relationship.resolvedThreats.length)
      parts.push(
        `ends capture threat to own ${briefPieces(relationship.resolvedThreats)}`
      )
    groups.push(parts)
  }
  const support = move.outcome.support
  if (features.support && support) {
    const parts: string[] = []
    const recapture = support.conditionalRecaptures.find(
      (capture) => capture.defenders.length > 0
    )
    if (recapture)
      parts.push(
        `after ${recapture.captureId}: own ${briefPieces(recapture.defenders)} can recapture`
      )
    else if (support.movedPieceGeometricDefenders.length)
      parts.push(
        `geometric support (not legal recapture): ${briefPieces(support.movedPieceGeometricDefenders)}`
      )
    const added = support.addedFriendlySupport[0]
    if (added)
      parts.push(
        `new geometric support: ${pieceAt(added.target)} covered by ${briefPieces(added.supporters)} (not legal recapture)`
      )
    groups.push(parts)
  }
  const castling = move.outcome.castling
  if (features.castling && castling) {
    const parts: string[] = []
    if (castling.lostRights.length)
      parts.push(
        `permanently loses held castling rights: ${castling.lostRights.map((right) => `${right.side === "ai" ? "black" : "white"} ${right.wing}`).join(", ")}`
      )
    const path = castling.paths.find(
      (entry) => entry.rightAfter && entry.clearedSquares.length > 0
    )
    if (path)
      parts.push(
        `${path.side === "ai" ? "black" : "white"} ${path.wing} clears ${path.clearedSquares.map(squareName).join(", ")}, ${path.pathClear ? `path clear, ${path.legalNow ? "legal on unchanged board" : "not currently legal"}` : `still blocked by ${path.blockersAfter.map(squareName).join(", ")}`}`
      )
    groups.push(parts)
  }
  const mobility = move.outcome.mobility
  if (features.mobility && mobility) {
    const parts: string[] = []
    if (mobility.pawnAdvance) {
      const { squares, centralSquaresControlled } = mobility.pawnAdvance
      parts.push(
        `pawn advances ${squares} square${squares === 1 ? "" : "s"}${centralSquaresControlled.length ? `, controls ${centralSquaresControlled.map(squareName).join(", ")}` : ""}`
      )
    }
    if (mobility.leavesMinorHomeSquare)
      parts.push(`${names[move.piece]} leaves its home rank`)
    const changed = mobility.changedOtherPieces[0]
    if (changed)
      parts.push(
        `own ${pieceAt(changed)} legal destinations ${changed.before}->${changed.after}${changed.newSquares.length ? `, adds ${changed.newSquares.slice(0, 2).map(squareName).join(", ")}${changed.newSquares.length > 2 ? ` +${changed.newSquares.length - 2}` : ""}` : ""}`
      )
    groups.push(parts)
  }
  // Rotate across enabled feature groups, then add their remaining details.
  // Preserve the full moved-piece attacker list even when it exceeds the budget.
  const extras: string[] = []
  let addedCharacters = 0
  const depth = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < depth && extras.length < 3; index++) {
    for (const group of groups) {
      const fact = group[index]
      if (!fact || extras.length === 3) continue
      if (addedCharacters + fact.length + 2 > 100 && fact !== fullAttackerFact)
        continue
      extras.push(fact)
      addedCharacters += fact.length + 2
    }
  }
  facts.push(...extras)
  return `${move.id}: ${names[move.piece]} ${squareName(move.path[0])}-${squareName(move.path[1])}; outcome: ${facts.join("; ")}`
}
