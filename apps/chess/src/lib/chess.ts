import { Chess, DEFAULT_POSITION } from "chess.js"
import type { Move as ChessMove } from "chess.js"
import type { OpponentSettings } from "./opponents.ts"

export type Side = "human" | "ai"
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k"
export type Piece = { side: Side; type: PieceType }
export type Board = (Piece | null)[]
export type Move = {
  /** UCI notation, including the chosen promotion piece, e.g. e7e8n. */
  id: string
  path: number[]
  captures: number[]
  promotes: boolean
  promotion?: PieceType
  notation: string
}
export type MoveRecord = {
  id: string
  side: Side
  piece: PieceType
  captured?: PieceType
  promotion?: PieceType
  notation: string
  path: number[]
  captures: number[]
  promoted: boolean
}
export type Game = {
  id: "current"
  sessionId: string
  opponent?: OpponentSettings
  board: Board
  /** The starting position plus UCI history retain repetition and special moves. */
  initialFen: string
  fen: string
  turn: Side
  status: "playing" | "human-won" | "ai-won" | "draw"
  history: MoveRecord[]
  updatedAt: number
  positions: string[]
  drawReason?: string
  inCheck: boolean
}

const sideOf = (color: string): Side => (color === "w" ? "human" : "ai")
const indexOf = (square: string) =>
  (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97

export function squareName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 63) {
    throw new RangeError("Square must be between 0 and 63.")
  }
  return `${String.fromCharCode(97 + (index % 8))}${8 - Math.floor(index / 8)}`
}

function describe(move: ChessMove): Move {
  const destination = indexOf(move.to)
  return {
    id: `${move.from}${move.to}${move.promotion ?? ""}`,
    path: [indexOf(move.from), destination],
    captures: move.isEnPassant()
      ? [destination + (move.color === "w" ? 8 : -8)]
      : move.captured
        ? [destination]
        : [],
    promotes: !!move.promotion,
    ...(move.promotion ? { promotion: move.promotion } : {}),
    notation: move.san
  }
}

function play(engine: Chess, id: string): ChessMove {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(id)) {
    throw new Error(`Illegal move: ${id}`)
  }
  const move = engine.move({
    from: id.slice(0, 2),
    to: id.slice(2, 4),
    ...(id[4] ? { promotion: id[4] } : {})
  })
  if ((move.promotion ?? "") !== (id[4] ?? "")) {
    throw new Error(`Illegal move: ${id}`)
  }
  return move
}

function restore(game: Game): Chess {
  const engine = new Chess(game.initialFen)
  for (const move of game.history) play(engine, move.id)
  if (engine.fen() !== game.fen) {
    throw new Error("Saved position does not match its move history.")
  }
  return engine
}

function positionKey(engine: Chess): string {
  return engine.fen().split(" ").slice(0, 4).join(" ")
}

function snapshot(
  engine: Chess
): Pick<Game, "board" | "fen" | "turn" | "status" | "drawReason" | "inCheck"> {
  let status: Game["status"] = "playing"
  let drawReason: string | undefined
  if (engine.isCheckmate()) {
    status = engine.turn() === "w" ? "ai-won" : "human-won"
  } else if (engine.isStalemate()) {
    drawReason = "Stalemate"
  } else if (engine.isThreefoldRepetition()) {
    drawReason = "Threefold repetition"
  } else if (engine.isDrawByFiftyMoves()) {
    drawReason = "Fifty-move rule"
  } else if (engine.isInsufficientMaterial()) {
    drawReason = "Insufficient material"
  }
  if (drawReason) status = "draw"
  return {
    board: engine
      .board()
      .flat()
      .map((piece) =>
        piece ? { side: sideOf(piece.color), type: piece.type } : null
      ),
    fen: engine.fen(),
    turn: sideOf(engine.turn()),
    status,
    drawReason,
    inCheck: engine.isCheck()
  }
}

export function fromFen(fen: string): Game {
  const engine = new Chess(fen)
  return {
    id: "current",
    sessionId: crypto.randomUUID(),
    initialFen: engine.fen(),
    history: [],
    updatedAt: Date.now(),
    positions: [positionKey(engine)],
    ...snapshot(engine)
  }
}

export function newGame(): Game {
  return fromFen(DEFAULT_POSITION)
}

/** White is always the human. Only moves that leave the king safe are exposed. */
export function legalMoves(game: Game): Move[] {
  if (game.status !== "playing") return []
  return restore(game).moves({ verbose: true }).map(describe)
}

export function applyMove(game: Game, id: string): Game {
  if (game.status !== "playing") throw new Error("This game is already over.")
  const engine = restore(game)
  const played = play(engine, id)
  const move = describe(played)
  const record: MoveRecord = {
    id: move.id,
    side: sideOf(played.color),
    piece: played.piece,
    notation: move.notation,
    path: move.path,
    captures: move.captures,
    promoted: move.promotes,
    ...(played.captured ? { captured: played.captured } : {}),
    ...(played.promotion ? { promotion: played.promotion } : {})
  }
  return {
    ...game,
    ...snapshot(engine),
    history: [...game.history, record],
    positions: [...game.positions, positionKey(engine)],
    updatedAt: Date.now()
  }
}

export function toPgn(game: Game): string {
  const engine = restore(game)
  engine.setHeader("White", "You")
  engine.setHeader("Black", "Browser AI")
  engine.setHeader(
    "Result",
    game.status === "human-won"
      ? "1-0"
      : game.status === "ai-won"
        ? "0-1"
        : game.status === "draw"
          ? "1/2-1/2"
          : "*"
  )
  return engine.pgn()
}
