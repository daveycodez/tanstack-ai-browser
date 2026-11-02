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
export type PieceRef = { piece: PieceType; square: number }
export type MoveRelationships = {
  movedPieceWasThreatened: boolean
  /** Actual legal next-turn captures, including en passant. */
  movedPieceThreatenedBy: PieceRef[]
  /** Hypothetical legal captures on the unchanged board, excluding kings. */
  newThreats: { target: PieceRef; attackers: PieceRef[] }[]
  resolvedThreats: { piece: PieceType; square: number; fromSquare: number }[]
}
export type AnnotatedMove = Move & {
  piece: PieceType
  captured?: PieceType
  outcome: {
    check: boolean
    checkmate: boolean
    stalemate: boolean
    allowsMateInOne: boolean
    relationships?: MoveRelationships
    drawReason?: string
    /** Distinct opposing pieces with a legal capture of the moved piece. */
    recapture: {
      count: number
      lowest?: { piece: PieceType; value: number | null; square: number }
    }
  }
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

function positionStatus(engine: Chess): Pick<Game, "status" | "drawReason"> {
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
  return { status, drawReason }
}

function snapshot(
  engine: Chess
): Pick<Game, "board" | "fen" | "turn" | "status" | "drawReason" | "inCheck"> {
  return {
    ...positionStatus(engine),
    board: engine
      .board()
      .flat()
      .map((piece) =>
        piece ? { side: sideOf(piece.color), type: piece.type } : null
      ),
    fen: engine.fen(),
    turn: sideOf(engine.turn()),
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

const pieceValues: Record<PieceType, number | null> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: null
}

type CaptureThreat = { piece: PieceType; attackers: Map<number, PieceRef> }
type CaptureMap = Map<number, CaptureThreat>

function captureMapFromMoves(moves: ChessMove[]): CaptureMap {
  const captures: CaptureMap = new Map()
  for (const move of moves) {
    // A synthetic turn can expose the inactive king. Kings are never capturable.
    if (!move.captured || move.captured === "k") continue
    const square = describe(move).captures[0]
    const source = indexOf(move.from)
    const threat = captures.get(square) ?? {
      piece: move.captured,
      attackers: new Map()
    }
    threat.attackers.set(source, { piece: move.piece, square: source })
    captures.set(square, threat)
  }
  return captures
}

/** Captures if this color moved on the unchanged board, with its own king safe. */
function hypotheticalCaptures(engine: Chess, color: "w" | "b"): CaptureMap {
  const fields = engine.fen().split(" ")
  if (fields[1] !== color) fields[3] = "-"
  fields[1] = color
  const clone = new Chess(fields.join(" "))
  return captureMapFromMoves(clone.moves({ verbose: true }))
}

function relationshipsAfterMove(
  engine: Chess,
  candidate: ChessMove,
  beforeOwn: CaptureMap,
  beforeEnemy: CaptureMap,
  afterEnemy: CaptureMap,
  recapturers: Map<number, { piece: PieceType; square: number }>
): MoveRelationships {
  const origin = indexOf(candidate.from)
  const destination = indexOf(candidate.to)
  const rankStart = Math.floor(origin / 8) * 8
  const relocate = (square: number): number => {
    if (square === origin) return destination
    if (candidate.isKingsideCastle() && square === rankStart + 7)
      return rankStart + 5
    if (candidate.isQueensideCastle() && square === rankStart)
      return rankStart + 3
    return square
  }
  const afterOwn = hypotheticalCaptures(engine, candidate.color)
  const newThreats: MoveRelationships["newThreats"] = []
  for (const [square, threat] of afterOwn) {
    const previous = new Set(
      [...(beforeOwn.get(square)?.attackers.keys() ?? [])].map(relocate)
    )
    if ([...threat.attackers.keys()].some((source) => !previous.has(source))) {
      newThreats.push({
        target: { piece: threat.piece, square },
        attackers: [...threat.attackers.values()]
      })
    }
  }
  const board = engine.board().flat()
  const resolvedThreats: MoveRelationships["resolvedThreats"] = []
  for (const [fromSquare] of beforeEnemy) {
    const square = relocate(fromSquare)
    const surviving = board[square]
    if (surviving?.color === candidate.color && !afterEnemy.has(square)) {
      resolvedThreats.push({ piece: surviving.type, square, fromSquare })
    }
  }
  return {
    movedPieceWasThreatened: beforeEnemy.has(origin),
    movedPieceThreatenedBy: [...recapturers.values()].map(
      ({ piece, square }) => ({ piece, square })
    ),
    newThreats,
    resolvedThreats
  }
}

/** Factual one-move outcomes; the model still chooses from every legal move. */
export function annotatedLegalMoves(
  game: Game,
  options: { relationships?: boolean } = {}
): AnnotatedMove[] {
  if (game.status !== "playing") return []
  const engine = restore(game)
  const candidates = engine.moves({ verbose: true })
  const beforeOwn = options.relationships
    ? captureMapFromMoves(candidates)
    : undefined
  const beforeEnemy = options.relationships
    ? hypotheticalCaptures(engine, engine.turn() === "w" ? "b" : "w")
    : undefined
  return candidates.map((candidate): AnnotatedMove => {
    const move = describe(candidate)
    engine.move(candidate)
    try {
      const state = positionStatus(engine)
      let allowsMateInOne = false
      let replies: ChessMove[] = []
      const defenders = new Map<
        number,
        { piece: PieceType; value: number | null; square: number }
      >()
      if (state.status === "playing") {
        replies = engine.moves({ verbose: true })
        for (const reply of replies) {
          if (reply.san.endsWith("#")) allowsMateInOne = true
          // An en passant reply lands elsewhere but removes the moved pawn.
          if (!describe(reply).captures.includes(indexOf(candidate.to)))
            continue
          const square = indexOf(reply.from)
          defenders.set(square, {
            piece: reply.piece,
            value: pieceValues[reply.piece],
            square
          })
        }
      }
      const lowest = [...defenders.values()].sort(
        (left, right) =>
          (left.value ?? Infinity) - (right.value ?? Infinity) ||
          left.square - right.square
      )[0]
      return {
        ...move,
        piece: candidate.piece,
        ...(candidate.captured ? { captured: candidate.captured } : {}),
        outcome: {
          check: engine.isCheck(),
          checkmate: state.status === "human-won" || state.status === "ai-won",
          stalemate: state.drawReason === "Stalemate",
          allowsMateInOne,
          ...(state.status === "playing" && beforeOwn && beforeEnemy
            ? {
                relationships: relationshipsAfterMove(
                  engine,
                  candidate,
                  beforeOwn,
                  beforeEnemy,
                  captureMapFromMoves(replies),
                  defenders
                )
              }
            : {}),
          ...(state.drawReason ? { drawReason: state.drawReason } : {}),
          recapture: { count: defenders.size, ...(lowest ? { lowest } : {}) }
        }
      }
    } finally {
      engine.undo()
    }
  })
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
