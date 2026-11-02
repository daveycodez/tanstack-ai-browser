import { squareName } from "./chess.ts"
import type { AnnotatedMove, Game, PieceRef, PieceType } from "./chess.ts"
import { describePosition } from "./ai-position.ts"
import { buildCompactChoices, buildStyledPrompt } from "./prompt-options.ts"
import type { PromptStyleInput } from "./prompt-options.ts"

export const SHARED_PROMPT_VERSION = "shared-v1-audited"

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
const pieceValues: Record<PieceType, number | string> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: "royal"
}
const pieceLabel = (piece: PieceRef) =>
  `${pieceNames[piece.piece]} (${pieceValues[piece.piece]}) on ${squareName(piece.square)}`

/** One fixed chess prompt for every adapter; preserve the caller's legal order. */
export function buildSharedPrompt({
  game,
  moves,
  currentThreats
}: SharedPromptInput): {
  prompt: string
  choices: { id: string; outcome: string }[]
} {
  // Retain the evaluated facts and choices while restoring recent move context.
  const input: PromptStyleInput = {
    baselinePrompt: "",
    moves,
    currentThreatData: currentThreats,
    board: describePosition(game),
    choices: moves.map((move) => ({ id: move.id, outcome: "" })),
    recentMoves: [],
    currentThreats: currentThreats.map(
      (threat) =>
        `Black ${pieceLabel(threat.target)} can be captured by White ${threat.attackers.map(pieceLabel).join(", ")}.`
    ),
    castlingMoves: moves.flatMap((move) =>
      move.notation.startsWith("O-O")
        ? [
            {
              id: move.id,
              wing: move.notation.startsWith("O-O-O")
                ? ("queenside" as const)
                : ("kingside" as const)
            }
          ]
        : []
    ),
    inCheck: game.inCheck,
    queenValue: 9,
    thinking: false
  }
  const choices = buildCompactChoices(input)
  input.choices = choices
  const recentMoves = game.history
    .slice(-8)
    .map(
      (move) =>
        `${move.side === "human" ? "White" : "Black"}: ${move.notation} (${move.id})`
    )
  const cardsHeading = "ALL LEGAL CARDS (random order, no ranking):"
  const prompt = buildStyledPrompt("compact-highlights", input).replace(
    cardsHeading,
    [
      "Recent 8 moves (oldest first):",
      ...(recentMoves.length ? recentMoves : ["none"]),
      cardsHeading
    ].join("\n")
  )
  return { prompt, choices }
}
