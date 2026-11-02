import { squareName } from "./chess.ts"
import type { AnnotatedMove, PieceRef, PieceType } from "./chess.ts"

export const PROMPT_STYLES = [
  { id: "baseline", label: "Baseline", repetitionPenalty: undefined },
  { id: "casual", label: "Casual priorities", repetitionPenalty: undefined },
  {
    id: "structured",
    label: "Structured context",
    repetitionPenalty: undefined
  },
  {
    id: "compact",
    label: "Compact action cards",
    repetitionPenalty: undefined
  },
  {
    id: "compact-castle",
    label: "Compact castling focus",
    repetitionPenalty: undefined
  },
  {
    id: "compact-safe-castle",
    label: "Compact conditional castling",
    repetitionPenalty: undefined
  },
  {
    id: "compact-highlights",
    label: "Compact immediate opportunities",
    repetitionPenalty: undefined
  },
  { id: "compact-copy", label: "Compact copy decoding", repetitionPenalty: 1 }
] as const

export type PromptStyleId = (typeof PROMPT_STYLES)[number]["id"]
export type PromptStyleMetadata = {
  id: PromptStyleId
  label: string
  repetitionPenalty?: number
}

export const DEFAULT_PROMPT_STYLE: PromptStyleId = "baseline"

/** Roll out only to the exact model evaluated; other adapters keep their profile. */
export function defaultPromptStyleFor(model: string): PromptStyleId {
  return model === "LiquidAI/LFM3-1.7B-GGUF"
    ? "compact-highlights"
    : DEFAULT_PROMPT_STYLE
}

export type PromptStyleInput = {
  baselinePrompt: string
  moves?: readonly AnnotatedMove[]
  currentThreatData?: readonly { target: PieceRef; attackers: PieceRef[] }[]
  board: string
  choices: readonly { id: string; outcome: string }[]
  recentMoves: readonly string[]
  currentThreats: readonly string[]
  castlingMoves: readonly { id: string; wing: "kingside" | "queenside" }[]
  inCheck: boolean
  queenValue: number
  thinking: boolean
}

const cardPieceNames: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
}

/** Literal consequences only: preserve every legal ID and the supplied order. */
export function buildCompactChoices(
  input: PromptStyleInput
): { id: string; outcome: string }[] {
  const byId = new Map(input.moves?.map((move) => [move.id, move]))
  const value: Record<PieceType, number | null> = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: input.queenValue,
    k: null
  }
  return input.choices.map((choice) => {
    const move = byId.get(choice.id)
    if (!move) return { ...choice }
    const facts: string[] = []
    if (move.captured) {
      const captureSquare = move.captures[0]
      facts.push(
        `CAPTURES ${cardPieceNames[move.captured]} (${value[move.captured]})${captureSquare !== undefined && captureSquare !== move.path[1] ? ` en passant on ${squareName(captureSquare)}` : ""}`
      )
    }
    if (move.promotion)
      facts.push(
        `PROMOTES TO ${cardPieceNames[move.promotion]} (${value[move.promotion]})`
      )
    if (move.notation.startsWith("O-O"))
      facts.push(
        `CASTLES ${move.notation.startsWith("O-O-O") ? "queenside" : "kingside"}`
      )
    const terminal =
      move.outcome.checkmate ||
      move.outcome.stalemate ||
      move.outcome.drawReason
    if (move.outcome.checkmate) facts.push("CHECKMATE: wins now")
    else if (move.outcome.stalemate) facts.push("STALEMATE: draw now")
    else if (move.outcome.drawReason)
      facts.push(`DRAW NOW: ${move.outcome.drawReason}`)
    if (!terminal) {
      if (move.outcome.allowsMateInOne)
        facts.push("WHITE CAN CHECKMATE NEXT TURN")
      const relations = move.outcome.relationships
      if (relations) {
        const savedQueens = relations.resolvedThreats.filter(
          (piece) => piece.piece === "q"
        )
        if (savedQueens.length)
          facts.push(
            `SAVES QUEEN FROM IMMEDIATE CAPTURE on ${savedQueens.map((piece) => squareName(piece.square)).join(",")}`
          )
        const savedOrigins = new Set(
          savedQueens.map((piece) => piece.fromSquare)
        )
        const stillThreatened = (input.currentThreatData ?? []).filter(
          (threat) =>
            threat.target.piece === "q" &&
            !savedOrigins.has(threat.target.square)
        )
        if (stillThreatened.length)
          facts.push(
            `QUEEN STILL IMMEDIATELY CAPTURABLE on ${stillThreatened.map((threat) => squareName(move.piece === "q" && threat.target.square === move.path[0] ? move.path[1] : threat.target.square)).join(",")}`
          )
      }
      if (move.outcome.recapture.count > 0 && value[move.piece] !== null) {
        // Promotion gains cancel when the promoted piece is immediately captured.
        const net =
          (move.captured ? (value[move.captured] ?? 0) : 0) -
          (value[move.piece] ?? 0)
        facts.push(
          `IF RECAPTURED NEXT TURN: ${net < 0 ? `loses ${-net}` : net > 0 ? `gains ${net}` : "even"} material`
        )
      } else if (move.captured) {
        facts.push("MOVED PIECE CANNOT BE LEGALLY RECAPTURED NEXT TURN")
      }
      if (move.outcome.check) facts.push("CHECK")
      if (move.outcome.mobility?.leavesMinorHomeSquare)
        facts.push(
          `${cardPieceNames[move.piece].toUpperCase()} LEAVES HOME SQUARE`
        )
      else if (move.piece === "p" && /^[de]/.test(squareName(move.path[1])))
        facts.push("PAWN ADVANCES ON CENTRAL FILE")
      if (!facts.length) facts.push("ORDINARY MOVE")
    }
    return {
      id: choice.id,
      outcome: `${choice.id} | ${cardPieceNames[move.piece]} ${squareName(move.path[0])}-${squareName(move.path[1])} | ${facts.join("; ")}`
    }
  })
}

/** Emphasize factual castling availability only when the supplied facts lack urgency. */
export function shouldUseCastlingFocus(input: PromptStyleInput): boolean {
  if (!input.castlingMoves.length || !input.moves || input.inCheck) return false
  if (input.currentThreatData?.some((threat) => threat.target.piece === "q"))
    return false
  const capturedValues: Record<PieceType, number> = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: input.queenValue,
    k: 0
  }
  return !input.moves.some(
    (move) =>
      move.outcome.checkmate ||
      move.outcome.allowsMateInOne ||
      (move.captured &&
        capturedValues[move.captured] >= 3 &&
        move.outcome.recapture.count === 0)
  )
}

/** Summarize immediate opportunities without changing the legal-choice list. */
export function immediateOpportunityHighlights(
  input: PromptStyleInput
): string[] {
  const byId = new Map(input.moves?.map((move) => [move.id, move]))
  const wins: string[] = []
  const queens: string[] = []
  for (const choice of input.choices) {
    const move = byId.get(choice.id)
    if (!move) continue
    if (move.outcome.checkmate) wins.push(choice.id)
    if (
      move.captured === "q" &&
      move.outcome.recapture.count === 0 &&
      !move.outcome.allowsMateInOne
    )
      queens.push(choice.id)
  }
  const facts: string[] = []
  if (wins.length)
    facts.push(`Black can WIN THIS TURN with: ${wins.join(", ")}.`)
  if (queens.length)
    facts.push(
      `Safe queen captures (no immediate recapture or opponent mate next turn): ${queens.join(", ")}.`
    )
  return facts.length ? ["AVAILABLE IMMEDIATE OPPORTUNITIES:", ...facts] : []
}

/** Change presentation and playing instructions while retaining every legal choice. */
export function buildStyledPrompt(
  style: PromptStyleId,
  input: PromptStyleInput
): string {
  if (style === "baseline") return input.baselinePrompt
  if (style === "compact-copy")
    return buildStyledPrompt("compact-highlights", input)
  if (
    style === "compact" ||
    style === "compact-castle" ||
    style === "compact-safe-castle" ||
    style === "compact-highlights"
  ) {
    const boardLines = input.board
      .split("\n")
      .filter((line) =>
        /^(Black pieces|White pieces|King:|Queens:|Rooks:|Bishops:|Knights:|Pawns:)/.test(
          line
        )
      )
    return [
      "Black to move. Play a fun, sensible casual game. Choose one legal card.",
      "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; otherwise CASTLE when listed; otherwise develop a knight/bishop or advance a central pawn.",
      "A check alone is not a reason to move. Consider IF RECAPTURED losses before taking material. Protection is not immunity. Pawn 1, knight/bishop 3, rook 5, queen " +
        input.queenValue +
        ".",
      ...(boardLines.length ? boardLines : [input.board]),
      `Black in check: ${input.inCheck ? "yes" : "no"}.`,
      "Current White capture possibilities on the unchanged board:",
      ...(input.currentThreats.length
        ? input.currentThreats
        : ["No threatened Black non-king pieces."]),
      `Legal CASTLE IDs now: ${input.castlingMoves.length ? input.castlingMoves.map((move) => `${move.wing} ${move.id}`).join(", ") : "none"}.`,
      "ALL LEGAL CARDS (random order, no ranking):",
      ...input.choices.map((choice) => choice.outcome),
      ...(style === "compact-castle" ||
      ((style === "compact-safe-castle" || style === "compact-highlights") &&
        shouldUseCastlingFocus(input))
        ? [
            "CASTLING CHECK BEFORE YOUR ANSWER:",
            `Legal castle choices in this position: ${input.castlingMoves.length ? input.castlingMoves.map((move) => `${move.wing} ${move.id}`).join(", ") : "none"}.`,
            `Black in check now: ${input.inCheck ? "yes" : "no"}.`,
            ...input.currentThreats.filter((threat) =>
              /^Black queen\b/i.test(threat)
            ),
            "When a legal castle is listed, prefer it over quiet moves, non-winning checks, and equal trades.",
            "Choose another move instead only to win immediately, prevent White's immediate mate, save an attacked queen, capture a free queen, or make a clearly favorable material capture.",
            "A check alone is not an exception. A capture marked as losing material if recaptured is not a clearly favorable trade. If no castle is listed, use the normal priorities."
          ]
        : []),
      ...(style === "compact-highlights"
        ? immediateOpportunityHighlights(input)
        : []),
      "Return exactly one JSON object: key moveId, value the chosen legal ID. Stop after its closing brace."
    ].join("\n")
  }
  if (style !== "casual" && style !== "structured")
    throw new RangeError(`Unknown chess prompt style: ${String(style)}`)
  const castling = input.castlingMoves.length
    ? input.castlingMoves.map((move) => `${move.wing}: ${move.id}`).join("; ")
    : "none"
  const threats = input.currentThreats.length
    ? input.currentThreats
    : [
        "No current legal capture of a Black non-king piece on the unchanged board."
      ]
  const commonFacts = [
    `Piece values: pawn 1, knight 3, bishop 3, rook 5, queen ${input.queenValue}; king is royal.`,
    "CHECKMATE wins now. DANGER means White has a legal checkmate next turn. Legal recapturers can capture your moved piece next turn; zero says nothing about your other pieces. If recaptured: net material is the material change through the immediate capture and reply, including promotion. A defender can sometimes recapture later; it does not make a piece immune.",
    "Every listed choice is legal. Castling rights alone do not mean castling is legal. Moves are randomly ordered, with no preference implied."
  ]
  const priorities = [
    "1. Take an immediate CHECKMATE, even when you can castle.",
    "2. Answer check and prevent White's immediate checkmate. Save an attacked queen when there is no immediate winning tactic.",
    "3. Take a free queen or a clear material gain. Avoid losing your queen after taking only a pawn or rook.",
    "4. Otherwise, castle when a legal castling move is listed. Prefer castling to another ordinary move.",
    "5. If you cannot castle, make a simple useful move: develop a knight or bishop, advance a central pawn, or keep your king covered.",
    "A check or capture is not automatically better. Use the board and outcome facts to decide."
  ]
  const output = [
    "Choose the exact UCI ID at the start of one listed move. Return one JSON object with moveId as its only key and the chosen UCI string as its value.",
    "Stop after that object's closing brace. Do not repeat the object or add commentary."
  ]
  const thinking = input.thinking
    ? [
        "Use your thinking for a short comparison of useful candidates and White's immediate reply. Do not restate the board or copy the move list. Keep the final answer to the single JSON object."
      ]
    : []
  if (style === "casual") {
    return [
      "Play Black in a friendly casual game of standard chess. Make simple, sensible moves using these beginner habits:",
      ...priorities,
      ...commonFacts,
      ...thinking,
      input.board,
      `Black in check now: ${input.inCheck ? "yes" : "no"}.`,
      "Current White capture possibilities against Black on the unchanged board:",
      ...threats,
      `Black can legally castle now: ${castling}.`,
      "Recent moves (oldest first):",
      ...(input.recentMoves.length ? input.recentMoves : ["none"]),
      "All legal choices and immediate outcomes:",
      ...input.choices.map((choice) => choice.outcome),
      ...output
    ].join("\n")
  }
  return [
    "ROLE: You play Black in a friendly casual chess game. White is the human. It is Black's turn.",
    "DECISION HABITS, IN ORDER:",
    ...priorities,
    "HOW TO READ THE FACTS:",
    ...commonFacts,
    ...thinking,
    "POSITION:",
    input.board,
    `Black in check now: ${input.inCheck ? "yes" : "no"}.`,
    "CURRENT THREATS TO BLACK (hypothetical legal White captures on the unchanged board):",
    ...threats,
    "LEGAL CASTLING NOW:",
    castling,
    "RECENT MOVES (oldest first):",
    ...(input.recentMoves.length ? input.recentMoves : ["none"]),
    "LEGAL CHOICES (all choices retained, random order):",
    ...input.choices.map((choice) => choice.outcome),
    "ANSWER:",
    ...output
  ].join("\n")
}
