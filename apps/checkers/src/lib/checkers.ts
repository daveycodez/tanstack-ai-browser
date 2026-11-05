import type { OpponentSettings } from "./opponents"
import type { UsageInfo } from "@tanstack/ai"

export type Side = "human" | "ai"
export type PieceColor = "white" | "black"
export type Piece = { side: Side; king: boolean }
export type Board = (Piece | null)[]
export type Move = {
  id: string
  path: number[]
  captures: number[]
  promotes: boolean
}
export type GameStatus = "playing" | "human-won" | "ai-won" | "draw"
export type PositionSnapshot = {
  board: Board
  turn: Side
  status: GameStatus
  quietMoves: number
  positions: string[]
}
export type AiDecisionTrace = {
  id: string
  sessionId: string
  ply: number
  mode: "forced" | "model"
  status: "success" | "error"
  positionBefore: PositionSnapshot
  model: OpponentSettings["model"]
  requestedThinking: boolean
  thinking: boolean
  reasoningMode: "off" | "native" | "emulated-working-notes"
  reasoningBudgetTokens: number | null
  maxOutputTokens: number | null
  sampling: "model defaults"
  legalMoveIds: string[]
  selectedMoveId?: string
  input?: {
    version: string
    systemPrompt: string
    outcomeVersion?: string
    prompt: string
    choices: { id: string; label: string; outcome: string }[]
  }
  rawAnswer?: string
  reasoningText: string
  usage?: UsageInfo
  startedAt: string
  finishedAt: string
  elapsedMs: number
  error?: string
}
export type MoveRecord = {
  side: Side
  notation: string
  path: number[]
  captures: number[]
  promoted: boolean
  analysis?: AiDecisionTrace
}
export type Game = {
  storageVersion?: string
  id: "current"
  sessionId: string
  opponent?: OpponentSettings
  humanColor?: PieceColor
  board: Board
  initialBoard?: Board
  initialTurn?: Side
  aiFailures?: AiDecisionTrace[]
  aiRetryFailureId?: string
  turn: Side
  status: GameStatus
  history: MoveRecord[]
  updatedAt: number
  quietMoves: number
  positions: string[]
}

const otherSide = (side: Side): Side => (side === "human" ? "ai" : "human")
const row = (index: number) => Math.floor(index / 8)
const col = (index: number) => index % 8
const crownRow = (side: Side) => (side === "human" ? 0 : 7)
const directions = (piece: Piece) =>
  piece.king ? [-1, 1] : [piece.side === "human" ? -1 : 1]
const inside = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8
const cloneBoard = (board: Board): Board =>
  board.map((piece) => (piece ? { ...piece } : null))

export function squareName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 63) {
    throw new RangeError("Square must be between 0 and 63.")
  }
  return `${String.fromCharCode(97 + col(index))}${8 - row(index)}`
}

export function positionKey(board: Board, turn: Side): string {
  return `${turn}:${board.map((piece) => (!piece ? "." : piece.side === "human" ? (piece.king ? "H" : "h") : piece.king ? "A" : "a")).join("")}`
}

function makeMove(path: number[], captures: number[], promotes: boolean): Move {
  return {
    id: path.map(squareName).join(captures.length ? "x" : "-"),
    path,
    captures,
    promotes
  }
}

/** Existing saves used the human-first setup; a missing assignment remains white. */
export function colorForSide(game: Pick<Game, "humanColor">, side: Side): PieceColor {
  const human = game.humanColor === "black" ? "black" : "white"
  return side === "human" ? human : human === "white" ? "black" : "white"
}

/** One random bit gives each color exactly half the possible byte values. */
export function randomHumanColor(): PieceColor {
  return crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? "white" : "black"
}

export function newGame(humanColor: PieceColor = randomHumanColor()): Game {
  const first: Side = humanColor === "white" ? "human" : "ai"
  const board: Board = Array.from({ length: 64 }, (_, index) => {
    const r = row(index)
    if ((r + col(index)) % 2 === 0 || (r > 2 && r < 5)) return null
    return { side: r < 3 ? "ai" : "human", king: false }
  })
  return {
    id: "current",
    sessionId: crypto.randomUUID(),
    humanColor,
    board,
    initialBoard: cloneBoard(board),
    initialTurn: first,
    aiFailures: [],
    turn: first,
    status: "playing",
    history: [],
    updatedAt: Date.now(),
    quietMoves: 0,
    positions: [positionKey(board, first)]
  }
}

/** Returns complete legal turns, including every required jump in a capture. */
export function legalMoves(board: Board, side: Side): Move[] {
  const captures: Move[] = []
  const steps: Move[] = []

  function jumps(
    current: Board,
    index: number,
    piece: Piece,
    path: number[],
    taken: number[]
  ) {
    let extended = false
    for (const dr of directions(piece)) {
      for (const dc of [-1, 1]) {
        const r = row(index) + 2 * dr
        const c = col(index) + 2 * dc
        if (!inside(r, c)) continue
        const middle = (row(index) + dr) * 8 + col(index) + dc
        const destination = r * 8 + c
        if (
          !current[middle] ||
          current[middle]?.side === side ||
          current[destination]
        )
          continue
        extended = true
        const next = current.slice()
        next[index] = null
        next[middle] = null
        next[destination] = piece
        const nextPath = [...path, destination]
        const nextTaken = [...taken, middle]
        // Under American rules, reaching the king row ends this turn immediately.
        if (!piece.king && r === crownRow(side)) {
          captures.push(makeMove(nextPath, nextTaken, true))
        } else {
          jumps(next, destination, piece, nextPath, nextTaken)
        }
      }
    }
    if (!extended && taken.length) captures.push(makeMove(path, taken, false))
  }

  for (let index = 0; index < 64; index++) {
    const piece = board[index]
    if (!piece || piece.side !== side) continue
    jumps(board, index, piece, [index], [])
    for (const dr of directions(piece)) {
      for (const dc of [-1, 1]) {
        const r = row(index) + dr
        const c = col(index) + dc
        if (!inside(r, c) || board[r * 8 + c]) continue
        steps.push(
          makeMove([index, r * 8 + c], [], !piece.king && r === crownRow(side))
        )
      }
    }
  }
  return captures.length ? captures : steps
}

/** Projects a selected (possibly incomplete) legal jump path for the board UI. */
export function previewBoard(board: Board, path: number[]): Board {
  const next = cloneBoard(board)
  if (path.length < 2) return next
  const origin = path[0]
  if (origin === undefined) return next
  const piece = next[origin]
  if (!piece) return next
  next[origin] = null
  let destination = origin
  for (const to of path.slice(1)) {
    if (Math.abs(row(to) - row(destination)) === 2) {
      next[
        ((row(destination) + row(to)) / 2) * 8 +
          (col(destination) + col(to)) / 2
      ] = null
    }
    destination = to
  }
  next[destination] = {
    ...piece,
    king: piece.king || row(destination) === crownRow(piece.side)
  }
  return next
}

/** Per-analysis memoization of board-only legality; history/draw state stays per transition. */
export function createMoveSearch() {
  const cache = new Map<string, Move[]>()
  const moves = (board: Board, turn: Side) => {
    const key = positionKey(board, turn)
    let found = cache.get(key)
    if (!found) { found = legalMoves(board, turn); cache.set(key, found) }
    return found
  }
  return { moves, apply: (game: Game, id: string) => applyWithMoves(game, id, moves) }
}

export function applyMove(game: Game, moveId: string): Game {
  return applyWithMoves(game, moveId, legalMoves)
}

function applyWithMoves(game: Game, moveId: string, moves: typeof legalMoves): Game {
  if (game.status !== "playing") throw new Error("This game is already over.")
  const move = moves(game.board, game.turn).find(
    (candidate) => candidate.id === moveId
  )
  if (!move) throw new Error(`Illegal move: ${moveId}`)
  const origin = move.path[0]
  if (origin === undefined) throw new Error("A legal move must have an origin.")
  const piece = game.board[origin]
  if (!piece) throw new Error("A legal move must start on an occupied square.")
  const board = previewBoard(game.board, move.path)
  const turn = otherSide(game.turn)
  // Forty moves per side without a capture or an uncrowned piece advancing.
  const quietMoves =
    move.captures.length || !piece.king ? 0 : game.quietMoves + 1
  const key = positionKey(board, turn)
  const positions = [...game.positions, key]
  let status: Game["status"] = "playing"
  if (!moves(board, turn).length) {
    status = game.turn === "human" ? "human-won" : "ai-won"
  } else if (
    quietMoves >= 80 ||
    positions.filter((position) => position === key).length >= 3
  ) {
    status = "draw"
  }
  return {
    ...game,
    board,
    turn,
    status,
    quietMoves,
    positions,
    updatedAt: Date.now(),
    history: [
      ...game.history,
      {
        side: game.turn,
        notation: move.id,
        path: [...move.path],
        captures: [...move.captures],
        promoted: move.promotes
      }
    ]
  }
}
