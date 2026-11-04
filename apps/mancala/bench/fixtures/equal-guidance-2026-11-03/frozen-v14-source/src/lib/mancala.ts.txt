import type { OpponentSettings } from "./opponents"

/** Counterclockwise board: your six pits, your store, their six pits, their store. */
export type Side = "human" | "ai"
export type Board = number[]
export type GameStatus = "playing" | "human-won" | "ai-won" | "draw"
export type MoveRecord = {
  side: Side
  pit: number
  seeds: number
  captured: number
  extraTurn: boolean
  notation: string
  drops: number[]
  boardBefore: Board
  boardAfter: Board
  finished: boolean
}
export type Game = {
  storageVersion?: string
  id: "current"
  sessionId: string
  opponent?: OpponentSettings
  board: Board
  turn: Side
  status: GameStatus
  history: MoveRecord[]
  updatedAt: number
}
export type SowResult = {
  board: Board
  turn: Side
  status: GameStatus
  drops: number[]
  captured: number
  extraTurn: boolean
  swept: { human: number; ai: number }
  lastPit: number
}

export const HUMAN_STORE = 6
export const AI_STORE = 13
export const TOTAL_SEEDS = 48
export const otherSide = (side: Side): Side =>
  side === "human" ? "ai" : "human"
export const storeIndex = (side: Side) =>
  side === "human" ? HUMAN_STORE : AI_STORE
export const sidePits = (side: Side): number[] =>
  side === "human" ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12]
export const oppositePit = (pit: number) => 12 - pit

export function pitName(pit: number): string {
  if (!Number.isInteger(pit) || pit < 0 || pit > 12 || pit === HUMAN_STORE) {
    throw new RangeError("Choose a pit, not a store.")
  }
  return String(pit < HUMAN_STORE ? pit + 1 : pit - HUMAN_STORE)
}

export function createGame(): Game {
  return {
    id: "current",
    sessionId: crypto.randomUUID(),
    board: [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0],
    turn: "human",
    status: "playing",
    history: [],
    updatedAt: Date.now()
  }
}
export const newGame = createGame

export function legalMoves(board: Board, side: Side): number[] {
  if (
    sidePits(side).every((pit) => board[pit] === 0) ||
    sidePits(otherSide(side)).every((pit) => board[pit] === 0)
  )
    return []
  return sidePits(side).filter((pit) => board[pit] > 0)
}

/** Pure Kalah transition. Drops preserve sowing order so the board can animate each seed. */
export function sow(board: Board, side: Side, pit: number): SowResult {
  if (
    board.length !== 14 ||
    board.some((seeds) => !Number.isSafeInteger(seeds) || seeds < 0)
  ) {
    throw new Error("The board must contain fourteen nonnegative seed counts.")
  }
  if (!Number.isInteger(pit) || !legalMoves(board, side).includes(pit)) {
    throw new Error("Choose one of your nonempty pits.")
  }
  const next = board.slice()
  const ownStore = storeIndex(side)
  const opponentStore = storeIndex(otherSide(side))
  const drops: number[] = []
  let remaining = next[pit]
  next[pit] = 0
  let cursor = pit
  while (remaining > 0) {
    cursor = (cursor + 1) % 14
    if (cursor === opponentStore) continue
    next[cursor]++
    drops.push(cursor)
    remaining--
  }

  let captured = 0
  if (
    sidePits(side).includes(cursor) &&
    next[cursor] === 1 &&
    next[oppositePit(cursor)] > 0
  ) {
    captured = next[oppositePit(cursor)] + 1
    next[ownStore] += captured
    next[cursor] = 0
    next[oppositePit(cursor)] = 0
  }

  const finished =
    sidePits("human").every((index) => next[index] === 0) ||
    sidePits("ai").every((index) => next[index] === 0)
  const swept = { human: 0, ai: 0 }
  if (finished) {
    for (const player of ["human", "ai"] as const) {
      for (const index of sidePits(player)) {
        swept[player] += next[index]
        next[index] = 0
      }
      next[storeIndex(player)] += swept[player]
    }
  }
  const extraTurn = cursor === ownStore && !finished
  const status: GameStatus = !finished
    ? "playing"
    : next[HUMAN_STORE] === next[AI_STORE]
      ? "draw"
      : next[HUMAN_STORE] > next[AI_STORE]
        ? "human-won"
        : "ai-won"
  return {
    board: next,
    turn: extraTurn ? side : otherSide(side),
    status,
    drops,
    captured,
    extraTurn,
    swept,
    lastPit: cursor
  }
}

export function applyMove(game: Game, pit: number): Game {
  if (game.status !== "playing")
    throw new Error("This game has finished. Start a new game to play again.")
  const result = sow(game.board, game.turn, pit)
  const record: MoveRecord = {
    side: game.turn,
    pit,
    seeds: game.board[pit],
    captured: result.captured,
    extraTurn: result.extraTurn,
    notation: `Pit ${pitName(pit)}${result.captured ? ` · captured ${result.captured}` : ""}${result.extraTurn ? " · go again" : ""}`,
    drops: result.drops,
    boardBefore: game.board.slice(),
    boardAfter: result.board.slice(),
    finished: result.status !== "playing"
  }
  return {
    ...game,
    board: result.board,
    turn: result.turn,
    status: result.status,
    history: [...game.history, record],
    updatedAt: Date.now()
  }
}

/** Deterministic reference player for rules checks; the app's opponents use local language models. */
export function chooseEngineMove(game: Game, depth = 7): number {
  if (game.status !== "playing")
    throw new Error("There is no move in a finished game.")
  const rootSide = game.turn
  const ownStore = storeIndex(rootSide)
  const theirStore = storeIndex(otherSide(rootSide))
  let remainingNodes = 30_000
  const evaluate = (board: Board, status: GameStatus) => {
    const difference = board[ownStore] - board[theirStore]
    if (status !== "playing")
      return difference === 0 ? 0 : Math.sign(difference) * 10_000 + difference
    const inPits =
      sidePits(rootSide).reduce((sum, index) => sum + board[index], 0) -
      sidePits(otherSide(rootSide)).reduce(
        (sum, index) => sum + board[index],
        0
      )
    return difference * 10 + inPits * 0.4
  }
  function search(
    board: Board,
    side: Side,
    status: GameStatus,
    left: number,
    alpha: number,
    beta: number
  ): number {
    if (left <= 0 || status !== "playing" || --remainingNodes <= 0)
      return evaluate(board, status)
    const maximize = side === rootSide
    let best = maximize ? -Infinity : Infinity
    const options = legalMoves(board, side)
      .map((pit) => sow(board, side, pit))
      .sort(
        (a, b) =>
          Number(b.extraTurn) - Number(a.extraTurn) || b.captured - a.captured
      )
    for (const next of options) {
      const value = search(
        next.board,
        next.turn,
        next.status,
        left - 1,
        alpha,
        beta
      )
      best = maximize ? Math.max(best, value) : Math.min(best, value)
      if (maximize) alpha = Math.max(alpha, best)
      else beta = Math.min(beta, best)
      if (beta <= alpha || remainingNodes <= 0) break
    }
    return best
  }
  let bestPit = -1
  let bestValue = -Infinity
  for (const pit of legalMoves(game.board, rootSide)) {
    const next = sow(game.board, rootSide, pit)
    const value = search(
      next.board,
      next.turn,
      next.status,
      Math.max(0, Math.min(depth, 12) - 1),
      -Infinity,
      Infinity
    )
    if (value > bestValue) {
      bestValue = value
      bestPit = pit
    }
  }
  if (bestPit < 0) throw new Error("There are no legal moves.")
  return bestPit
}
