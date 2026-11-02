import { squareName } from "./chess.ts"
import type { AnnotatedMove, Game, PieceRef, PieceType } from "./chess.ts"
import { describePosition } from "./ai-position.ts"
import { buildCompactChoices } from "./prompt-options.ts"

export const SHARED_PROMPT_VERSION = "shared-v5"

export type SharedPromptInput = {
  game: Game
  moves: readonly AnnotatedMove[]
  currentThreats: readonly { target: PieceRef; attackers: PieceRef[] }[]
}

const pieceNames: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
}
const numericValues: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
}
const pieceLabel = (piece: PieceRef) =>
  `${pieceNames[piece.piece]} (${piece.piece === "k" ? "royal" : numericValues[piece.piece]}) on ${squareName(piece.square)}`

/** Positive factual summaries; the complete legal-choice list remains below. */
export function positiveSafetySummaries({
  moves,
  currentThreats
}: Pick<SharedPromptInput, "moves" | "currentThreats">): string[] {
  const facts: string[] = []
  let hasKingSafeChoices = false
  let hasQueenRescueChoices = false
  let hasMaterialSafeChoices = false
  if (moves.some((move) => move.outcome.allowsMateInOne)) {
    const safe = moves.filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMajorLosses !== undefined &&
        move.outcome.replyMajorLosses.length === 0
    )
    if (safe.length) {
      hasKingSafeChoices = true
      facts.push(
        `KING-SAFE CHOICES FOR THE NEXT TURN: ${safe.map((move) => move.id).join(", ")}. Each prevents an immediate White checkmate without an uncompensated queen or rook loss.`
      )
    }
  }
  if (currentThreats.some((threat) => threat.target.piece === "q")) {
    const rescues = moves.filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.relationships?.resolvedThreats.some(
          (piece) => piece.piece === "q"
        )
    )
    if (rescues.length) {
      hasQueenRescueChoices = true
      facts.push(
        `Black can RESCUE AN ATTACKED QUEEN from immediate legal capture with: ${rescues.map((move) => move.id).join(", ")}.`
      )
    }
  }
  const hasImmediateWin = moves.some((move) => move.outcome.checkmate)
  if (
    !hasImmediateWin &&
    moves.some((move) =>
      move.outcome.replyMaterialLosses?.some((loss) => loss.netMaterial < 0)
    )
  ) {
    const safe = moves.filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMaterialLosses?.length === 0
    )
    if (safe.length) {
      hasMaterialSafeChoices = true
      facts.push(
        `MATERIAL-SAFE CHOICES FOR THE NEXT TURN: ${safe.map((move) => move.id).join(", ")}. No checked immediate capture exchange loses Black material; White has no mate in one.`
      )
    }
  }
  if (
    !hasImmediateWin &&
    (hasKingSafeChoices || hasQueenRescueChoices || hasMaterialSafeChoices)
  ) {
    facts.push("URGENT RESPONSE PRIORITY:")
    if (hasKingSafeChoices)
      facts.push(
        "Before ordinary development or castling, choose one of the KING-SAFE choices above to address the immediate threat."
      )
    if (hasQueenRescueChoices)
      facts.push(
        "Address the attacked queen with one of the queen-rescue choices above that prevents an immediate White win, before ordinary development or castling."
      )
    if (hasMaterialSafeChoices)
      facts.push(
        "After addressing the king and any attacked queen, prefer a MATERIAL-SAFE choice. When there is no urgent threat, castle if a listed castle is MATERIAL-SAFE."
      )
  }
  return facts.length ? ["URGENT POSITION FACTS:", ...facts] : []
}

/** One fixed chess prompt for every adapter; preserve the caller's legal order. */
export function buildSharedPrompt({
  game,
  moves,
  currentThreats
}: SharedPromptInput): {
  prompt: string
  choices: { id: string; outcome: string }[]
} {
  const movesById = new Map(moves.map((move) => [move.id, move]))
  const choices = buildCompactChoices({
    moves,
    currentThreatData: currentThreats,
    choices: moves.map((move) => ({ id: move.id, outcome: "" })),
    queenValue: 9
  }).map((choice) => {
    let outcome = choice.outcome.replace(
      "WHITE CAN CHECKMATE NEXT TURN",
      "DANGER TO BLACK: White can win on its next move"
    )
    const move = movesById.get(choice.id)
    if (
      move &&
      !move.outcome.checkmate &&
      !move.outcome.stalemate &&
      !move.outcome.drawReason
    ) {
      const fullExchangeFacts = move.outcome.replyMaterialLosses
      if (fullExchangeFacts !== undefined) {
        outcome = outcome
          .replace(/IF RECAPTURED NEXT TURN: [^;]+(?:; )?/, "")
          .replace(/; $/, "")
        if (outcome.endsWith(" | "))
          outcome += "COMPENSATING RECAPTURE AVAILABLE"
      }
      const losses =
        fullExchangeFacts ??
        move.outcome.replyMajorLosses?.filter(
          (loss) => loss.square !== move.path[1]
        )
      const exposed = losses
        ?.filter((loss) => loss.netMaterial < 0)
        .sort((left, right) => left.netMaterial - right.netMaterial)[0]
      if (exposed) {
        outcome += `; DANGER TO BLACK: after this move White ${pieceLabel(exposed.capturedBy)} can take Black ${pieceLabel({ piece: exposed.piece, square: exposed.square })}; possible immediate exchange net ${exposed.netMaterial}`
        const newThreat = move.outcome.relationships?.newThreats[0]
        if (newThreat)
          outcome += `; Black also threatens White ${pieceLabel(newThreat.target)} on the unchanged board; White moves next`
      }
    }
    return { ...choice, outcome }
  })
  const board = describePosition(game)
    .split("\n")
    .filter((line) =>
      /^(Black pieces|White pieces|King:|Queens:|Rooks:|Bishops:|Knights:|Pawns:)/.test(
        line
      )
    )
  const threats = currentThreats.map(
    (threat) =>
      `Black ${pieceLabel(threat.target)} can be captured by White ${threat.attackers.map(pieceLabel).join(", ")}.`
  )
  const castles = moves.flatMap((move) =>
    move.notation.startsWith("O-O")
      ? [
          {
            id: move.id,
            wing: move.notation.startsWith("O-O-O") ? "queenside" : "kingside"
          }
        ]
      : []
  )
  const castleIds =
    castles.map((move) => `${move.wing} ${move.id}`).join(", ") || "none"
  const focusCastling =
    castles.length > 0 &&
    !game.inCheck &&
    !currentThreats.some((threat) => threat.target.piece === "q") &&
    !moves.some(
      (move) =>
        move.outcome.checkmate ||
        move.outcome.allowsMateInOne ||
        (move.captured &&
          numericValues[move.captured] >= 3 &&
          move.outcome.recapture.count === 0)
    )
  const wins = moves
    .filter((move) => move.outcome.checkmate)
    .map((move) => move.id)
  const queenCaptures = moves
    .filter(
      (move) =>
        move.captured === "q" &&
        move.outcome.recapture.count === 0 &&
        !move.outcome.allowsMateInOne
    )
    .map((move) => move.id)
  const recent = game.history
    .slice(-8)
    .map(
      (move) =>
        `${move.side === "human" ? "White" : "Black"}: ${move.notation} (${move.id})`
    )
  const prompt = [
    "Black to move. Play a fun, sensible casual game. Choose one legal card.",
    "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; otherwise CASTLE when listed; otherwise develop a knight/bishop or advance a central pawn.",
    "A check alone is not a reason to move. Consider conditional exchange losses before taking material. Protection is not immunity. Pawn 1, knight/bishop 3, rook 5, queen 9.",
    ...board,
    `Black in check: ${game.inCheck ? "yes" : "no"}.`,
    "Current White capture possibilities on the unchanged board:",
    ...(threats.length ? threats : ["No threatened Black non-king pieces."]),
    `Legal CASTLE IDs now: ${castleIds}.`,
    "Recent 8 moves (oldest first):",
    ...(recent.length ? recent : ["none"]),
    "ALL LEGAL CARDS (random order, no ranking):",
    ...choices.map((choice) => choice.outcome),
    ...(focusCastling
      ? [
          "CASTLING CHECK BEFORE YOUR ANSWER:",
          `Legal castle choices in this position: ${castleIds}.`,
          `Black in check now: ${game.inCheck ? "yes" : "no"}.`,
          ...threats.filter((threat) => /^Black queen\b/i.test(threat)),
          "When a legal castle has no listed conditional material-loss branch, prefer it over quiet moves, non-winning checks, and equal trades.",
          "Choose another move instead only to win immediately, prevent White's immediate mate, save an attacked queen, capture a free queen, or make a clearly favorable material capture.",
          "A check alone is not an exception. A capture marked as losing material if recaptured is not a clearly favorable trade. If no castle is listed, use the normal priorities."
        ]
      : []),
    ...(wins.length || queenCaptures.length
      ? [
          "AVAILABLE IMMEDIATE OPPORTUNITIES:",
          ...(wins.length
            ? [`Black can WIN THIS TURN with: ${wins.join(", ")}.`]
            : []),
          ...(queenCaptures.length
            ? [
                `Safe queen captures (no immediate recapture or opponent mate next turn): ${queenCaptures.join(", ")}.`
              ]
            : [])
        ]
      : []),
    ...positiveSafetySummaries({ moves, currentThreats }),
    "Return exactly one JSON object: key moveId, value the chosen legal ID. Stop after its closing brace."
  ].join("\n")
  return { prompt, choices }
}
