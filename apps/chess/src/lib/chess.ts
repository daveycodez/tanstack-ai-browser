import { Chess, DEFAULT_POSITION } from "chess.js"
import type { Move as ChessMove, Square } from "chess.js"
import type { OpponentSettings } from "./opponents.ts"

export type Side = "human" | "ai"
export type PieceColor = "white" | "black"
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
  addedFriendlySupport: {
    target: PieceRef
    supporters: PieceRef[]
    beforeCount: number
    afterCount: number
    wasThreatened: boolean
  }[]
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
/** Pawn locations around an actual wing king or a retained future castle wing.
 * Counts describe locations only, never king safety or castling legality.
 */
export type KingCoverProfile = {
  side: Side
  wing: CastlingWing
  kind: "current" | "future"
  kingSquare: number
  pawnSquares: number[]
  homeFiles: string[]
  nearFiles: string[]
  advancedFiles: string[]
  missingFiles: string[]
}
export type MoveKingCover = {
  before: KingCoverProfile[]
  after: KingCoverProfile[]
  relevantWings: CastlingWing[]
  landing?: KingCoverProfile
}
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
/** A possible opponent capture branch after the best immediate material recapture.
 * Negative is conditional material loss, not a forced line or a positional score.
 */
export type ReplyMaterialLoss = {
  piece: PieceType
  square: number
  /** Opposing source piece and square before its capture; promotion is in netMaterial. */
  capturedBy: PieceRef
  netMaterial: number
  /** Optional bounded capture continuation, in SAN; opponent moves first. */
  exchangeLine?: string[]
}
/** Compatibility view containing only queen/rook captures. */
export type ReplyMajorLoss = ReplyMaterialLoss
export type QuietForkThreat = {
  replyId: string
  replyNotation: string
  attacker: PieceRef
  targets: PieceRef[]
  captureDefense: "none" | "losing" | "unresolved"
  captureNet?: number
  /** Starts with your attempted capture of the attacker. */
  captureLine?: string[]
  /** Best immediate defense against the fork, followed by bounded capture play. */
  responseNet?: number
  responseLine?: string[]
}
export type PromotionReply = {
  id: string
  from: number
  to: number
  promotion: "q" | "r" | "b" | "n"
  captured?: PieceType
  check: boolean
  checkmate: boolean
  capturableBy: PieceRef[]
  /** Mover's material delta after the candidate and this actual promotion reply. */
  netAfterPromotion: number
  /** Best immediate material result among legal captures of the promoted piece. */
  netAfterImmediateCapture?: number
}
export type KingMobility = {
  /** Distinct legal destinations, including castling destinations where legal. */
  before: number[]
  after: number[]
  deniedSquares: number[]
  newSquares: number[]
  afterInCheck: boolean
  otherLegalReplyCount: number
  opponentNonPawnNonKingCount: number
  opponentPawnCount: number
  opponentBareKing: boolean
  /** Chebyshev distance only against a bare king; not a positional score. */
  ownKingDistance?: { before: number; after: number }
}
export type MoveContextOptions = {
  relationships?: boolean
  support?: boolean
  mobility?: boolean
  castling?: boolean
  kingCover?: boolean
  promotionReplies?: boolean
  kingMobility?: boolean
  safety?: boolean
  /** Opt-in capture settlement; historical prompts retain immediate recapture math. */
  exchangeTail?: boolean
  /** Opt-in extra opponent capture after a compensating local recapture. */
  exchangeFollowupCapture?: boolean
  /** Include a direct capture example only when it explains the entire net. */
  captureLineExamples?: boolean
  /** Opt-in preview of legal noncapturing opponent forks. */
  quietForks?: boolean
  /** Certify the fork cost across every immediate legal defense. */
  checkForkResponses?: boolean
  /** Stop a fork proof once a legal defense cannot worsen the known risk. */
  pruneDominatedForks?: boolean
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
    kingCover?: MoveKingCover
    promotionReplies?: PromotionReply[]
    kingMobility?: KingMobility
    replyMaterialLosses?: ReplyMaterialLoss[]
    replyMajorLosses?: ReplyMajorLoss[]
    quietForkThreats?: QuietForkThreat[]
    /** The opt-in extra capture tree hit a bound or a draw-ending branch. */
    exchangeFollowupUnresolved?: boolean
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
  /** Changes after each durable write, including settings edits within one ply. */
  storageVersion?: string
  opponent?: OpponentSettings
  /** Missing in legacy saves, where the human always played White. */
  humanColor?: PieceColor
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

export function colorForSide(game: Pick<Game, "humanColor">, side: Side): PieceColor {
  const human = game.humanColor === "black" ? "black" : "white"
  return side === "human" ? human : human === "white" ? "black" : "white"
}
export function colorName(game: Pick<Game, "humanColor">, side: Side): "White" | "Black" {
  return colorForSide(game, side) === "white" ? "White" : "Black"
}
export function randomHumanColor(): PieceColor {
  return crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? "white" : "black"
}
const sideOf = (color: string, humanColor: PieceColor = "white"): Side =>
  (color === "w") === (humanColor === "white") ? "human" : "ai"
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

function positionStatus(engine: Chess, humanColor: PieceColor = "white"): Pick<Game, "status" | "drawReason"> {
  let status: Game["status"] = "playing"
  let drawReason: string | undefined
  if (engine.isCheckmate()) {
    status = sideOf(engine.turn(), humanColor) === "human" ? "ai-won" : "human-won"
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
  engine: Chess,
  humanColor: PieceColor = "white"
): Pick<Game, "board" | "fen" | "turn" | "status" | "drawReason" | "inCheck"> {
  return {
    ...positionStatus(engine, humanColor),
    board: engine
      .board()
      .flat()
      .map((piece) =>
        piece ? { side: sideOf(piece.color, humanColor), type: piece.type } : null
      ),
    fen: engine.fen(),
    turn: sideOf(engine.turn(), humanColor),
    inCheck: engine.isCheck()
  }
}

export function fromFen(fen: string, humanColor: PieceColor = "white"): Game {
  const engine = new Chess(fen)
  return {
    id: "current",
    sessionId: crypto.randomUUID(),
    humanColor,
    initialFen: engine.fen(),
    history: [],
    updatedAt: Date.now(),
    positions: [positionKey(engine)],
    ...snapshot(engine, humanColor)
  }
}

export function newGame(humanColor: PieceColor = randomHumanColor()): Game {
  return fromFen(DEFAULT_POSITION, humanColor)
}

/** Only moves that leave the current mover’s king safe are exposed. */
export function legalMoves(game: Game): Move[] {
  if (game.status !== "playing") return []
  return restore(game).moves({ verbose: true }).map(describe)
}

/** Read-only moves for the current snapshot, without replaying history.
 * Game status still suppresses history-dependent draws. Commits and analysis
 * retain restore() so saved-history validation and adjudication are unchanged.
 */
export function positionLegalMoves(game: Game): Move[] {
  if (game.status !== "playing") return []
  return new Chess(game.fen).moves({ verbose: true }).map(describe)
}

/** Empty adjacent destinations attacked after the current king vacates its square.
 * Geometric attacks include pinned defenders, as required for king safety.
 * Works after checkmate, when the normal legal-move list is empty.
 */
export function unsafeKingDestinations(game: Game): number[] {
  const from = game.board.findIndex(piece => piece?.type === "k" && piece.side === game.turn)
  if (from < 0) return []
  const engine = new Chess(game.fen)
  const color = engine.turn()
  const enemy = color === "w" ? "b" : "w"
  const king = engine.remove(squareName(from) as Square)
  if (!king) return []
  const unsafe: number[] = []
  const row = Math.floor(from / 8), file = from % 8
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const y = row + dy, x = file + dx
      if ((!dx && !dy) || y < 0 || y > 7 || x < 0 || x > 7) continue
      const square = y * 8 + x
      if (game.board[square]) continue
      const target = squareName(square) as Square
      engine.put(king, target)
      if (engine.isAttacked(target, enemy)) unsafe.push(square)
      engine.remove(target)
    }
  }
  return unsafe
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

type ReplyAnalysis = {
  recaptures: ChessMove[]
  check: boolean
  checkmate: boolean
}
type AnalyzeReply = (reply: ChessMove) => ReplyAnalysis

/** Scoped to one candidate on the live history-bearing engine. Reply identity
 * avoids sharing results between equal boards with different draw histories.
 */
function replyAnalyzer(engine: Chess): AnalyzeReply {
  const cache = new Map<ChessMove, ReplyAnalysis>()
  return (reply) => {
    const cached = cache.get(reply)
    if (cached) return cached
    engine.move(reply)
    try {
      const state = positionStatus(engine)
      const result = {
        recaptures: state.status === "playing"
          ? engine.moves({ verbose: true }).filter(move =>
              describe(move).captures.includes(indexOf(reply.to)))
          : [],
        check: engine.isCheck(),
        checkmate: state.status === "human-won" || state.status === "ai-won"
      }
      cache.set(reply, result)
      return result
    } finally {
      engine.undo()
    }
  }
}

function supportAfterMove(
  engine: Chess,
  candidate: ChessMove,
  before: CaptureMap,
  beforeEnemy: CaptureMap,
  replies: ChessMove[],
  analyzeReply: AnalyzeReply
): MoveSupport {
  const destination = indexOf(candidate.to)
  const after = geometricSupport(engine, candidate.color)
  const conditionalRecaptures: MoveSupport["conditionalRecaptures"] = []
  for (const capture of replies) {
    if (!describe(capture).captures.includes(destination)) continue
    const defenders = new Map<number, PieceRef>()
    for (const recapture of analyzeReply(capture).recaptures) {
      if (recapture.captured === "k") continue
      const square = indexOf(recapture.from)
      defenders.set(square, { piece: recapture.piece, square })
    }
    conditionalRecaptures.push({
      captureId: describe(capture).id,
      attacker: {
        piece: capture.promotion ?? capture.piece,
        square: indexOf(capture.to)
      },
      defenders: [...defenders.values()]
    })
  }
  const addedFriendlySupport: MoveSupport["addedFriendlySupport"] = []
  for (const [square, target] of after) {
    const originalSquare =
      Array.from({ length: 64 }, (_, source) => source).find(
        (source) =>
          source !== square && relocatedSquare(candidate, source) === square
      ) ?? square
    const previous = new Set(
      [...(before.get(originalSquare)?.attackers.keys() ?? [])].map((source) =>
        relocatedSquare(candidate, source)
      )
    )
    const supporters = [...target.attackers.values()].filter(
      (piece) => !previous.has(piece.square)
    )
    if (supporters.length)
      addedFriendlySupport.push({
        target: { piece: target.piece, square },
        supporters,
        beforeCount: previous.size,
        afterCount: target.attackers.size,
        wasThreatened: beforeEnemy.has(originalSquare)
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
  otherMoves: ChessMove[],
  humanColor: PieceColor = "white"
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
        side: sideOf(color, humanColor),
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
  after: CastleSnapshot[],
  humanColor: PieceColor = "white"
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
          !(performed && path.side === sideOf(candidate.color, humanColor))
      )
      .map(({ side, wing }) => ({ side, wing })),
    paths: before.flatMap((path, index) => {
      const next = after[index]
      // Paths describe a future castle only while its original right survives.
      // Rights consumed by an actual castle are represented by performed alone.
      if (!path.right || !next.right) return []
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

function kingCoverProfiles(
  engine: Chess,
  color: "w" | "b",
  humanColor: PieceColor = "white"
): KingCoverProfile[] {
  const board = engine.board().flat()
  const kingSquare = board.findIndex(
    (piece) => piece?.color === color && piece.type === "k"
  )
  const backRank = color === "w" ? 7 : 0
  if (Math.floor(kingSquare / 8) !== backRank) return []
  const kingFile = kingSquare % 8
  const rights = engine.fen().split(" ")[2]
  return (["kingside", "queenside"] as const).flatMap((wing) => {
    const key = wing === "kingside" ? "k" : "q"
    const current = (wing === "kingside" ? [6, 7] : [1, 2]).includes(kingFile)
    const future =
      kingFile === 4 && rights.includes(color === "w" ? key.toUpperCase() : key)
    if (!current && !future) return []
    const files = wing === "kingside" ? ["f", "g", "h"] : ["a", "b", "c"]
    const pawnSquares = board.flatMap((piece, square) =>
      piece?.color === color &&
      piece.type === "p" &&
      files.includes(squareName(square)[0])
        ? [square]
        : []
    )
    const occupied = (file: string) =>
      pawnSquares.filter((square) => squareName(square)[0] === file)
    const distance = (square: number) =>
      Math.abs(Math.floor(square / 8) - backRank)
    const nearFiles = files.filter((file) =>
      occupied(file).some(
        (square) => distance(square) >= 1 && distance(square) <= 2
      )
    )
    return [
      {
        side: sideOf(color, humanColor),
        wing,
        kind: current ? ("current" as const) : ("future" as const),
        kingSquare,
        pawnSquares,
        homeFiles: files.filter((file) =>
          occupied(file).some((square) => distance(square) === 1)
        ),
        nearFiles,
        advancedFiles: files.filter(
          (file) => occupied(file).length && !nearFiles.includes(file)
        ),
        missingFiles: files.filter((file) => !occupied(file).length)
      }
    ]
  })
}
function kingCoverAfterMove(
  engine: Chess,
  candidate: ChessMove,
  before: KingCoverProfile[],
  humanColor: PieceColor = "white"
): MoveKingCover {
  const after = kingCoverProfiles(engine, candidate.color, humanColor)
  const performed = candidate.isKingsideCastle()
    ? "kingside"
    : candidate.isQueensideCastle()
      ? "queenside"
      : undefined
  const relevantWings = (["kingside", "queenside"] as const)
    .filter((wing) => {
      const previous = before.find((profile) => profile.wing === wing)
      const next = after.find((profile) => profile.wing === wing)
      const files = wing === "kingside" ? "fgh" : "abc"
      return (
        JSON.stringify(previous) !== JSON.stringify(next) ||
        (candidate.piece === "p" &&
          (files.includes(candidate.from[0]) ||
            files.includes(candidate.to[0])))
      )
    })
    .filter(
      (wing) =>
        before.some((profile) => profile.wing === wing) ||
        after.some((profile) => profile.wing === wing)
    )
  const landing = performed
    ? after.find(
        (profile) => profile.wing === performed && profile.kind === "current"
      )
    : undefined
  return { before, after, relevantWings, ...(landing ? { landing } : {}) }
}

function promotionReplyOutcome(
  candidate: ChessMove,
  reply: ChessMove,
  analyzeReply: AnalyzeReply
): PromotionReply {
  if (!reply.promotion || reply.promotion === "p" || reply.promotion === "k") {
    throw new Error("Expected an actual legal promotion reply.")
  }
  const value = (piece: PieceType) => pieceValues[piece] ?? 0
  const netAfterPromotion =
    (candidate.captured ? value(candidate.captured) : 0) +
    (candidate.promotion ? value(candidate.promotion) - value("p") : 0) -
    (reply.captured ? value(reply.captured) : 0) -
    (value(reply.promotion) - value("p"))
  const { recaptures: captures, check, checkmate } = analyzeReply(reply)
  const capturers = new Map<number, PieceRef>()
  for (const capture of captures) {
    const square = indexOf(capture.from)
    capturers.set(square, { piece: capture.piece, square })
  }
  return {
    id: describe(reply).id,
    from: indexOf(reply.from),
    to: indexOf(reply.to),
    promotion: reply.promotion,
    ...(reply.captured ? { captured: reply.captured } : {}),
    check,
    checkmate,
    capturableBy: [...capturers.values()],
    netAfterPromotion,
    ...(captures.length ? {
      netAfterImmediateCapture: netAfterPromotion + Math.max(...captures.map((capture) =>
        value(reply.promotion ?? "p") + (capture.promotion ? value(capture.promotion) - value("p") : 0)))
    } : {})
  }
}

function kingMobilityAfterMove(
  engine: Chess,
  candidate: ChessMove,
  beforeMoves: ChessMove[],
  replies: ChessMove[],
  beforeBoard: ReturnType<Chess["board"]>
): KingMobility {
  const destinations = (moves: ChessMove[]) => [...new Set(moves.filter((move) => move.piece === "k" && move.captured !== "k").map((move) => indexOf(move.to)))]
  const before = destinations(beforeMoves)
  const after = destinations(replies)
  const board = engine.board().flat()
  const opponent = candidate.color === "w" ? "b" : "w"
  const opposing = board.filter((piece) => piece?.color === opponent)
  const opponentNonPawnNonKingCount = opposing.filter((piece) => piece?.type !== "p" && piece?.type !== "k").length
  const opponentPawnCount = opposing.filter((piece) => piece?.type === "p").length
  const opponentBareKing = opposing.length === 1 && opposing[0]?.type === "k"
  const kingIndex = (pieces: ReturnType<Chess["board"]>[number], color: "w" | "b") => pieces.findIndex((piece) => piece?.color === color && piece.type === "k")
  const old = beforeBoard.flat()
  const distance = (left: number, right: number) => Math.max(Math.abs(left % 8 - right % 8), Math.abs(Math.floor(left / 8) - Math.floor(right / 8)))
  return {
    before, after,
    deniedSquares: before.filter((square) => !after.includes(square)),
    newSquares: after.filter((square) => !before.includes(square)),
    afterInCheck: engine.isCheck(),
    otherLegalReplyCount: replies.filter((move) => move.piece !== "k").length,
    opponentNonPawnNonKingCount, opponentPawnCount, opponentBareKing,
    ...(opponentBareKing ? { ownKingDistance: {
      before: distance(kingIndex(old, candidate.color), kingIndex(old, opponent)),
      after: distance(kingIndex(board, candidate.color), kingIndex(board, opponent))
    } } : {})
  }
}

/** Capture-only settlement, optionally including one further opponent capture
 * after a local recapture. Either side may leave through a legal other move.
 * Quiet follow-ups are not searched.
 * A recapture which permits immediate mate cannot count as compensation.
 * The engine retains real history and is restored on every return/abort.
 */
function settledRecaptureGain(engine: Chess, reply: ChessMove, requireFirstCapture = false, followLandingSquare = false, followupCapture = false): { gain: number; line: string[] } | undefined {
  let nodes = followupCapture ? 512 : 128
  const limit = Symbol("exchange limit")
  const value = (piece: PieceType) => pieceValues[piece] ?? 0
  function visit(sign: 1 | -1, knownLegal?: ChessMove[], requireCapture = false, target: Square = reply.to, extraAvailable = followupCapture): { gain: number; line: string[] } {
    if (--nodes < 0) throw limit
    if (positionStatus(engine).status !== "playing") return { gain: 0, line: [] }
    const legal = knownLegal ?? engine.moves({ verbose: true })
    const onTarget = (move: ChessMove) => describe(move).captures.includes(indexOf(target))
    const captures = legal.filter(move => move.captured && (onTarget(move) || (extraAvailable && sign === -1)))
    // Any actual legal move outside this local exchange can end the preview.
    let best = !requireCapture && legal.some(move => !captures.includes(move)) ? { gain: 0, line: [] as string[] } : undefined
    for (const capture of captures) {
      engine.move(capture)
      try {
        // A material return that loses the game next turn is not compensation.
        const nextLegal = engine.moves({ verbose: true })
        if (nextLegal.some(move => move.san.endsWith("#"))) continue
        // Do not turn a draw-ending branch into a certified material-loss forecast.
        if (followupCapture && engine.isDraw()) throw limit
        const outside = !onTarget(capture)
        const tail = visit(sign === 1 ? -1 : 1, nextLegal, false, followLandingSquare || followupCapture || outside ? capture.to : target, extraAvailable && !outside)
        const gain = sign * (value(capture.captured ?? "p") + (capture.promotion ? value(capture.promotion) - value("p") : 0)) + tail.gain
        if (!best || (sign === 1 ? gain > best.gain : gain < best.gain)) best = { gain, line: [capture.san, ...tail.line] }
      } finally { engine.undo() }
    }
    // No usable recapture is a zero material return, not a claim of survival.
    return best ?? { gain: 0, line: [] }
  }
  engine.move(reply)
  try { return visit(1, undefined, requireFirstCapture) }
  catch (error) { if (error === limit) return undefined; throw error }
  finally { engine.undo() }
}

/** Check every immediate defense, not just captures of the forking piece.
 * The opponent's next legal captures use the bounded exchange tree; later quiet
 * plans are outside the claim. Incomplete searches publish no certified cost.
 */
function checkedForkResponses(engine: Chess, reply: ChessMove, riskFloor?: number): { net: number; line: string[] } | undefined {
  let nodes = 512
  const limit = Symbol("fork response limit")
  const tick = () => { if (--nodes < 0) throw limit }
  engine.move(reply)
  try {
    if (positionStatus(engine).status !== "playing") return { net: 0, line: [] }
    let best = -Infinity, bestLine: string[] = []
    for (const defense of engine.moves({ verbose: true })) {
      tick(); engine.move(defense)
      try {
        if (positionStatus(engine).status !== "playing") return { net: 0, line: [defense.san] }
        const replies = engine.moves({ verbose: true })
        // Never rate a defense allowing mate as better than a material loss.
        if (replies.some(move => move.san.endsWith("#"))) continue
        let worst = 0, witness: string[] = []
        const analyze = replyAnalyzer(engine)
        for (const capture of replies.filter(move => move.captured && move.captured !== "k")) {
          tick(); engine.move(capture)
          let credible = false
          try {
            credible = positionStatus(engine).status === "playing" && !engine.moves().some(san => san.endsWith("#"))
          } finally { engine.undo() }
          if (!credible) continue
          const settlement = settledRecaptureGain(engine, capture, false, true)
          if (!settlement) throw limit
          const loss = materialLossAfterReply(defense, capture, analyze, settlement)
          if (loss && loss.netMaterial < worst) { worst = loss.netMaterial; witness = loss.exchangeLine ?? [capture.san] }
          // Further opponent replies cannot improve an already inferior defense.
          if (worst <= best) break
        }
        if (worst >= 0) return { net: 0, line: [defense.san] }
        if (riskFloor !== undefined && worst >= riskFloor) return undefined
        if (worst > best) { best = worst; bestLine = [defense.san, ...witness] }
      } finally { engine.undo() }
    }
    return Number.isFinite(best) ? { net: best, line: bestLine } : undefined
  } catch (error) { if (error === limit) return undefined; throw error }
  finally { engine.undo() }
}

/** A legal quiet reply may create a fork before capturing anything. These are
 * conditional threats, not a claim that every defense loses. Safe local capture
 * defenses suppress the warning; other defenses are deliberately not ranked.
 */
function quietForkAfterReply(engine: Chess, reply: ChessMove, checkResponses = false, riskFloor?: number): QuietForkThreat | undefined {
  if (reply.captured || reply.san.endsWith("#")) return undefined
  const preview = new Chess(reply.after)
  const potential = preview.board().flat().flatMap((piece, square): PieceRef[] => {
    if (!piece || piece.color === reply.color || piece.type === "p") return []
    if (piece.type === "k" && !reply.san.endsWith("+")) return []
    return preview.attackers(squareName(square) as Square, reply.color).includes(reply.to)
      ? [{ piece: piece.type, square }] : []
  })
  if (potential.length < 2) return undefined
  let targets: PieceRef[], captures: ChessMove[]
  engine.move(reply)
  try {
    if (positionStatus(engine).status !== "playing") return undefined
    // Reject geometric targets which the moved piece cannot legally capture.
    const future = hypotheticalEngine(engine, reply.color).moves({ verbose: true })
      .filter(move => move.from === reply.to && move.captured && move.captured !== "k")
    targets = potential.filter(target => target.piece === "k" || future.some(move => move.to === squareName(target.square)))
    if (targets.length < 2) return undefined
    captures = engine.moves({ verbose: true }).filter(move => describe(move).captures.includes(indexOf(reply.to)))
  } finally { engine.undo() }
  if (checkResponses) {
    const response = checkedForkResponses(engine, reply, riskFloor)
    if (!response || response.net >= 0) return undefined
    return { replyId: describe(reply).id, replyNotation: reply.san,
      attacker: { piece: reply.piece, square: indexOf(reply.to) }, targets,
      captureDefense: captures.length ? "unresolved" : "none",
      responseNet: response.net, responseLine: [reply.san, ...response.line] }
  }
  const defense = captures.length ? settledRecaptureGain(engine, reply, true) : undefined
  if (defense?.line.length && defense.gain >= 0) return undefined
  const losing = defense && defense.line.length > 0 && defense.gain < 0
  return {
    replyId: describe(reply).id, replyNotation: reply.san,
    attacker: { piece: reply.piece, square: indexOf(reply.to) }, targets,
    captureDefense: !captures.length ? "none" : losing ? "losing" : "unresolved",
    ...(losing ? { captureNet: defense.gain, captureLine: defense.line } : {})
  }
}

function materialLossAfterReply(
  candidate: ChessMove,
  reply: ChessMove,
  analyzeReply: AnalyzeReply,
  exchange?: { gain: number; line: string[] },
  directLine = false
): ReplyMaterialLoss | undefined {
  if (!reply.captured || reply.captured === "k") return undefined
  const value = (piece: PieceType) => pieceValues[piece] ?? 0
  const candidateGain =
    (candidate.captured ? value(candidate.captured) : 0) +
    (candidate.promotion ? value(candidate.promotion) - value("p") : 0)
  const promotionGain = reply.promotion
    ? value(reply.promotion) - value("p")
    : 0
  const attackerValue = value(reply.promotion ?? reply.piece)
  const recaptures = analyzeReply(reply).recaptures
  // Material only: include a recapturing pawn's promotion, without evaluating
  // positional strength or later play. The opponent need not choose this line.
  const recaptureGain = Math.max(
    0,
    ...recaptures.map(
      (recapture) =>
        attackerValue +
        (recapture.promotion ? value(recapture.promotion) - value("p") : 0)
    )
  )
  const netMaterial =
    candidateGain - value(reply.captured) - promotionGain + (exchange?.gain ?? recaptureGain)
  if (netMaterial >= 0) return undefined
  return {
    piece: reply.captured,
    square: describe(reply).captures[0],
    capturedBy: { piece: reply.piece, square: indexOf(reply.from) },
    netMaterial,
    ...(exchange ? { exchangeLine: [reply.san, ...exchange.line] } : directLine && netMaterial === candidateGain - value(reply.captured) - promotionGain ? { exchangeLine: [reply.san] } : {})
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
    options.relationships || options.castling || options.support || options.kingMobility
      ? hypotheticalEngine(engine, engine.turn() === "w" ? "b" : "w").moves({
          verbose: true
        })
      : []
  const beforeEnemy =
    options.relationships || options.support
      ? captureMapFromMoves(beforeOtherMoves)
      : undefined
  const beforeSupport = options.support
    ? geometricSupport(engine, engine.turn())
    : undefined
  const beforeBoard = options.mobility || options.kingMobility ? engine.board() : undefined
  const beforeCastling = options.castling
    ? castlingSnapshot(engine, candidates, beforeOtherMoves, game.humanColor)
    : undefined
  const beforeKingCover = options.kingCover
    ? kingCoverProfiles(engine, engine.turn(), game.humanColor)
    : undefined
  return candidates.map((candidate): AnnotatedMove => {
    const move = describe(candidate)
    engine.move(candidate)
    try {
      const state = positionStatus(engine, game.humanColor)
      const analyzeReply = replyAnalyzer(engine)
      let allowsMateInOne = false
      let exchangeFollowupUnresolved = false
      let replies: ChessMove[] = []
      const quietForkThreats: QuietForkThreat[] | undefined = options.quietForks ? [] : undefined
      const promotionReplies: PromotionReply[] | undefined = options.promotionReplies ? [] : undefined
      const replyMaterialLosses: ReplyMaterialLoss[] | undefined =
        options.safety ? [] : undefined
      const replyMajorLosses: ReplyMajorLoss[] | undefined = options.safety
        ? []
        : undefined
      const defenders = new Map<
        number,
        { piece: PieceType; value: number | null; square: number }
      >()
      if (state.status === "playing") {
        replies = engine.moves({ verbose: true })
        for (const reply of replies) {
          if (reply.san.endsWith("#")) allowsMateInOne = true
          if (quietForkThreats && !options.pruneDominatedForks) { const fork = quietForkAfterReply(engine, reply, options.checkForkResponses); if (fork) quietForkThreats.push(fork) }
          if (promotionReplies && reply.promotion) promotionReplies.push(promotionReplyOutcome(candidate, reply, analyzeReply))
          if (replyMaterialLosses) {
            const immediate = materialLossAfterReply(candidate, reply, analyzeReply, undefined, options.captureLineExamples)
            const needsExchange = options.exchangeTail && !immediate && reply.captured && analyzeReply(reply).recaptures.length
            const exchange = needsExchange ? settledRecaptureGain(engine, reply, false, false, options.exchangeFollowupCapture) : undefined
            if (needsExchange && options.exchangeFollowupCapture && !exchange) exchangeFollowupUnresolved = true
            const loss = exchange ? materialLossAfterReply(candidate, reply, analyzeReply, exchange, options.captureLineExamples) : immediate
            if (loss) {
              replyMaterialLosses.push(loss)
              if (loss.piece === "q" || loss.piece === "r")
                replyMajorLosses?.push(loss)
            }
          }
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
        if (quietForkThreats && options.pruneDominatedForks && !allowsMateInOne) {
          const value = (piece: PieceType) => pieceValues[piece] ?? 0
          const initialGain = (candidate.captured ? value(candidate.captured) : 0) + (candidate.promotion ? value(candidate.promotion) - value("p") : 0)
          let riskFloor = Math.min(0, ...(replyMaterialLosses ?? []).map(loss => loss.netMaterial))
          for (const reply of replies) {
            const promotionGain = reply.promotion ? value(reply.promotion) - value("p") : 0
            const fork = quietForkAfterReply(engine, reply, options.checkForkResponses, riskFloor - initialGain + promotionGain)
            if (fork) {
              quietForkThreats.push(fork)
              if (fork.responseNet !== undefined) riskFloor = Math.min(riskFloor, initialGain - promotionGain + fork.responseNet)
            }
          }
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
          ...(promotionReplies ? { promotionReplies } : {}),
          ...(quietForkThreats ? { quietForkThreats } : {}),
          ...(exchangeFollowupUnresolved ? { exchangeFollowupUnresolved: true } : {}),
          ...(options.kingMobility && beforeBoard ? { kingMobility: kingMobilityAfterMove(engine, candidate, beforeOtherMoves, replies, beforeBoard) } : {}),
          ...(replyMaterialLosses
            ? { replyMaterialLosses, replyMajorLosses }
            : {}),
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
                  beforeEnemy ?? new Map(),
                  replies,
                  analyzeReply
                )
              }
            : {}),
          ...(state.status === "playing" && options.mobility && beforeBoard
            ? {
                mobility: mobilityAfterMove(
                  candidate,
                  beforeBoard,
                  candidates,
                  ownAfterMoves
                )
              }
            : {}),
          ...(beforeKingCover
            ? {
                kingCover: kingCoverAfterMove(
                  engine,
                  candidate,
                  beforeKingCover,
                  game.humanColor
                )
              }
            : {}),
          ...(beforeCastling
            ? {
                castling: castlingAfterMove(
                  candidate,
                  beforeCastling,
                  castlingSnapshot(engine, replies, ownAfterMoves, game.humanColor),
                  game.humanColor
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
    side: sideOf(played.color, game.humanColor),
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
    ...snapshot(engine, game.humanColor),
    history: [...game.history, record],
    positions: [...game.positions, positionKey(engine)],
    updatedAt: Date.now()
  }
}

export function toPgn(game: Game): string {
  const engine = restore(game)
  engine.setHeader(colorName(game, "human"), "You")
  engine.setHeader(colorName(game, "ai"), "Browser AI")
  engine.setHeader(
    "Result",
    game.status === "human-won"
      ? colorForSide(game, "human") === "white" ? "1-0" : "0-1"
      : game.status === "ai-won"
        ? colorForSide(game, "ai") === "white" ? "1-0" : "0-1"
        : game.status === "draw"
          ? "1/2-1/2"
          : "*"
  )
  return engine.pgn()
}
