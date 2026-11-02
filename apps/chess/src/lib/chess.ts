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
export type MoveSupport = {
  movedPieceGeometricDefenders: PieceRef[]
  conditionalRecaptures: {
    captureId: string
    attacker: PieceRef
    defenders: PieceRef[]
  }[]
  addedFriendlySupport: { target: PieceRef; supporters: PieceRef[] }[]
}
export type MoveMobility = {
  pawnAdvance?: { squares: 1 | 2; centralSquaresControlled: number[] }
  leavesMinorHomeSquare: boolean
  changedOtherPieces: {
    piece: PieceType
    fromSquare: number
    square: number
    before: number
    after: number
    newSquares: number[]
  }[]
}
export type CastlingWing = "kingside" | "queenside"
export type MoveCastling = {
  performed?: CastlingWing
  lostRights: { side: Side; wing: CastlingWing }[]
  paths: {
    side: Side
    wing: CastlingWing
    rightBefore: boolean
    rightAfter: boolean
    blockersBefore: number[]
    blockersAfter: number[]
    clearedSquares: number[]
    pathClear: boolean
    legalNow: boolean
  }[]
}
export type MoveContextOptions = {
  relationships?: boolean
  support?: boolean
  mobility?: boolean
  castling?: boolean
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
    support?: MoveSupport
    mobility?: MoveMobility
    castling?: MoveCastling
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
function hypotheticalEngine(engine: Chess, color: "w" | "b"): Chess {
  const fields = engine.fen().split(" ")
  if (fields[1] !== color) fields[3] = "-"
  fields[1] = color
  return new Chess(fields.join(" "))
}

function relationshipsAfterMove(
  engine: Chess,
  candidate: ChessMove,
  beforeOwn: CaptureMap,
  beforeEnemy: CaptureMap,
  afterOwn: CaptureMap,
  afterEnemy: CaptureMap,
  recapturers: Map<number, { piece: PieceType; square: number }>
): MoveRelationships {
  const origin = indexOf(candidate.from)
  const relocate = (square: number) => relocatedSquare(candidate, square)
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

/** Opponent capture threats if that color moved on the unchanged current board.
 * Kings/check are separate, and pinned captures are excluded.
 */
export function currentThreats(
  game: Game
): { target: PieceRef; attackers: PieceRef[] }[] {
  if (game.status !== "playing") return []
  const engine = restore(game)
  const opponent = engine.turn() === "w" ? "b" : "w"
  const captures = captureMapFromMoves(
    hypotheticalEngine(engine, opponent).moves({ verbose: true })
  )
  return [...captures].map(([square, threat]) => ({
    target: { piece: threat.piece, square },
    attackers: [...threat.attackers.values()]
  }))
}

type ChessSquare = Parameters<Chess["get"]>[0]
const asSquare = (index: number) => squareName(index) as ChessSquare

function relocatedSquare(candidate: ChessMove, square: number): number {
  const origin = indexOf(candidate.from)
  if (square === origin) return indexOf(candidate.to)
  const rankStart = Math.floor(origin / 8) * 8
  if (candidate.isKingsideCastle() && square === rankStart + 7)
    return rankStart + 5
  if (candidate.isQueensideCastle() && square === rankStart)
    return rankStart + 3
  return square
}

/** Friendly geometric coverage, excluding placements that expose the own king.
 * This models coverage of a friendly square, not a legal self-capture.
 */
function geometricSupport(engine: Chess, color: "w" | "b"): CaptureMap {
  const result: CaptureMap = new Map()
  const board = engine.board().flat()
  const king = board.findIndex(
    (piece) => piece?.color === color && piece.type === "k"
  )
  const enemy = color === "w" ? "b" : "w"
  const clone = new Chess(engine.fen())
  for (let square = 0; square < 64; square++) {
    const target = board[square]
    if (!target || target.color !== color || target.type === "k") continue
    const attackers = new Map<number, PieceRef>()
    for (const source of engine.attackers(asSquare(square), color)) {
      const supporter = engine.get(source)
      if (!supporter) continue
      clone.remove(source)
      clone.remove(asSquare(square))
      clone.put(supporter, asSquare(square))
      const kingSquare = supporter.type === "k" ? square : king
      const safe =
        kingSquare >= 0 && !clone.isAttacked(asSquare(kingSquare), enemy)
      clone.remove(asSquare(square))
      clone.put(target, asSquare(square))
      clone.put(supporter, source)
      if (safe)
        attackers.set(indexOf(source), {
          piece: supporter.type,
          square: indexOf(source)
        })
    }
    if (attackers.size) result.set(square, { piece: target.type, attackers })
  }
  return result
}

function supportAfterMove(
  engine: Chess,
  candidate: ChessMove,
  before: CaptureMap,
  replies: ChessMove[]
): MoveSupport {
  const destination = indexOf(candidate.to)
  const after = geometricSupport(engine, candidate.color)
  const conditionalRecaptures: MoveSupport["conditionalRecaptures"] = []
  for (const capture of replies) {
    if (!describe(capture).captures.includes(destination)) continue
    engine.move(capture)
    try {
      const defenders = new Map<number, PieceRef>()
      if (positionStatus(engine).status === "playing") {
        for (const recapture of engine.moves({ verbose: true })) {
          if (
            recapture.captured === "k" ||
            !describe(recapture).captures.includes(indexOf(capture.to))
          )
            continue
          const square = indexOf(recapture.from)
          defenders.set(square, { piece: recapture.piece, square })
        }
      }
      conditionalRecaptures.push({
        captureId: describe(capture).id,
        attacker: {
          piece: capture.promotion ?? capture.piece,
          square: indexOf(capture.to)
        },
        defenders: [...defenders.values()]
      })
    } finally {
      engine.undo()
    }
  }
  const addedFriendlySupport: MoveSupport["addedFriendlySupport"] = []
  for (const [square, target] of after) {
    const originalSquare = [...before.keys()].find(
      (source) => relocatedSquare(candidate, source) === square
    )
    const previous = new Set(
      [
        ...(originalSquare === undefined
          ? []
          : (before.get(originalSquare)?.attackers.keys() ?? []))
      ].map((source) => relocatedSquare(candidate, source))
    )
    const supporters = [...target.attackers.values()].filter(
      (piece) => !previous.has(piece.square)
    )
    if (supporters.length)
      addedFriendlySupport.push({
        target: { piece: target.piece, square },
        supporters
      })
  }
  return {
    movedPieceGeometricDefenders: [
      ...(after.get(destination)?.attackers.values() ?? [])
    ],
    conditionalRecaptures,
    addedFriendlySupport
  }
}

function mobilityAfterMove(
  candidate: ChessMove,
  beforeBoard: ReturnType<Chess["board"]>,
  beforeMoves: ChessMove[],
  afterMoves: ChessMove[]
): MoveMobility {
  const destinations = (moves: ChessMove[], from: number) =>
    new Set(
      moves
        .filter((move) => indexOf(move.from) === from && move.captured !== "k")
        .map((move) => indexOf(move.to))
    )
  const changedOtherPieces: MoveMobility["changedOtherPieces"] = []
  beforeBoard.flat().forEach((piece, fromSquare) => {
    if (
      piece?.color !== candidate.color ||
      fromSquare === indexOf(candidate.from)
    )
      return
    const square = relocatedSquare(candidate, fromSquare)
    if (square !== fromSquare) return // The castling rook also moved.
    const before = destinations(beforeMoves, fromSquare)
    const after = destinations(afterMoves, square)
    const newSquares = [...after].filter(
      (destination) => !before.has(destination)
    )
    if (before.size !== after.size || newSquares.length)
      changedOtherPieces.push({
        piece: piece.type,
        fromSquare,
        square,
        before: before.size,
        after: after.size,
        newSquares
      })
  })
  const destination = indexOf(candidate.to)
  const row = Math.floor(destination / 8)
  const column = destination % 8
  const controlled = [-1, 1]
    .filter((offset) => column + offset >= 0 && column + offset < 8)
    .map(
      (offset) =>
        (row + (candidate.color === "w" ? -1 : 1)) * 8 + column + offset
    )
  const central = new Set([
    indexOf("d4"),
    indexOf("e4"),
    indexOf("d5"),
    indexOf("e5")
  ])
  const home = candidate.color === "w" ? "1" : "8"
  const homeFiles =
    candidate.piece === "n"
      ? ["b", "g"]
      : candidate.piece === "b"
        ? ["c", "f"]
        : []
  return {
    ...(candidate.piece === "p"
      ? {
          pawnAdvance: {
            squares: candidate.isBigPawn() ? (2 as const) : (1 as const),
            centralSquaresControlled: controlled.filter((square) =>
              central.has(square)
            )
          }
        }
      : {}),
    leavesMinorHomeSquare: homeFiles.some(
      (file) => candidate.from === file + home
    ),
    changedOtherPieces
  }
}

type CastleSnapshot = {
  side: Side
  wing: CastlingWing
  right: boolean
  blockers: number[]
  legal: boolean
}
function castlingSnapshot(
  engine: Chess,
  ownMoves: ChessMove[],
  otherMoves: ChessMove[]
): CastleSnapshot[] {
  const rights = engine.fen().split(" ")[2]
  const board = engine.board().flat()
  return (["w", "b"] as const).flatMap((color) =>
    (["kingside", "queenside"] as const).map((wing) => {
      const start = color === "w" ? 56 : 0
      const path = wing === "kingside" ? [5, 6] : [1, 2, 3]
      const key = wing === "kingside" ? "k" : "q"
      const moves = color === engine.turn() ? ownMoves : otherMoves
      return {
        side: sideOf(color),
        wing,
        right: rights.includes(color === "w" ? key.toUpperCase() : key),
        blockers: path
          .map((column) => start + column)
          .filter((square) => board[square]),
        legal: moves.some(
          (move) =>
            move.color === color &&
            (wing === "kingside"
              ? move.isKingsideCastle()
              : move.isQueensideCastle())
        )
      }
    })
  )
}
function castlingAfterMove(
  candidate: ChessMove,
  before: CastleSnapshot[],
  after: CastleSnapshot[]
): MoveCastling {
  const performed = candidate.isKingsideCastle()
    ? "kingside"
    : candidate.isQueensideCastle()
      ? "queenside"
      : undefined
  return {
    ...(performed ? { performed } : {}),
    lostRights: before
      .filter(
        (path, index) =>
          path.right &&
          !after[index].right &&
          !(performed && path.side === sideOf(candidate.color))
      )
      .map(({ side, wing }) => ({ side, wing })),
    paths: before.flatMap((path, index) => {
      const next = after[index]
      if (!path.right && !next.right) return []
      return [
        {
          side: path.side,
          wing: path.wing,
          rightBefore: path.right,
          rightAfter: next.right,
          blockersBefore: path.blockers,
          blockersAfter: next.blockers,
          clearedSquares: path.blockers.filter(
            (square) => !next.blockers.includes(square)
          ),
          pathClear: !next.blockers.length,
          legalNow: next.right && next.legal
        }
      ]
    })
  }
}

/** Factual one-move outcomes; the model still chooses from every legal move. */
export function annotatedLegalMoves(
  game: Game,
  options: MoveContextOptions = {}
): AnnotatedMove[] {
  if (game.status !== "playing") return []
  const engine = restore(game)
  const candidates = engine.moves({ verbose: true })
  const beforeOwn = options.relationships
    ? captureMapFromMoves(candidates)
    : undefined
  const beforeOtherMoves =
    options.relationships || options.castling
      ? hypotheticalEngine(engine, engine.turn() === "w" ? "b" : "w").moves({
          verbose: true
        })
      : []
  const beforeEnemy = options.relationships
    ? captureMapFromMoves(beforeOtherMoves)
    : undefined
  const beforeSupport = options.support
    ? geometricSupport(engine, engine.turn())
    : undefined
  const beforeBoard = options.mobility ? engine.board() : undefined
  const beforeCastling = options.castling
    ? castlingSnapshot(engine, candidates, beforeOtherMoves)
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
      const ownAfterMoves =
        state.status === "playing" &&
        (options.relationships || options.mobility || options.castling)
          ? hypotheticalEngine(engine, candidate.color).moves({ verbose: true })
          : []
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
                  captureMapFromMoves(ownAfterMoves),
                  captureMapFromMoves(replies),
                  defenders
                )
              }
            : {}),
          ...(state.status === "playing" && beforeSupport
            ? {
                support: supportAfterMove(
                  engine,
                  candidate,
                  beforeSupport,
                  replies
                )
              }
            : {}),
          ...(state.status === "playing" && beforeBoard
            ? {
                mobility: mobilityAfterMove(
                  candidate,
                  beforeBoard,
                  candidates,
                  ownAfterMoves
                )
              }
            : {}),
          ...(beforeCastling
            ? {
                castling: castlingAfterMove(
                  candidate,
                  beforeCastling,
                  castlingSnapshot(engine, replies, ownAfterMoves)
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
