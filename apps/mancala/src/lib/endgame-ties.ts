import { legalMoves, sow } from "./mancala.ts"
import type { Board, Game, Side } from "./mancala.ts"

export const ENDGAME_TIE_VERSION = "terminal-margin-v1" as const
export type EndgameTieOptions = {
  maxRemainingSeeds?: number
  maxNodes?: number
  maxTableEntries?: number
}
export type EndgameTieMove = {
  pit: number
  finalMargin: number
  aiStore: number
  humanStore: number
  /** Exact margin-optimal prefix through this AI turn only; ends at Human handoff. */
  principalLine: { side: Side; pit: number }[]
  bestAiTurn: number[]
}
export type EndgameTieResult = {
  complete: boolean
  reason:
    "solved" | "single-choice" | "too-many-seeds" | "not-playing" | "node-limit"
  remainingSeeds: number
  /** Logical visits for this solve, retained when its result is reused. */
  nodes: number
  moves: EndgameTieMove[]
  bestPits: number[]
}

export type EndgameTieSolver = (
  game: Game,
  candidates: readonly number[],
  options?: EndgameTieOptions
) => EndgameTieResult

type RequestMemo = {
  lookup: (key: string) => EndgameTieResult | undefined
  remember: (key: string, result: EndgameTieResult) => void
}
const MAX_REQUEST_RESULTS = 4
const copyResult = (result: EndgameTieResult): EndgameTieResult => ({
  ...result,
  moves: result.moves.map((move) => ({
    ...move,
    principalLine: move.principalLine.map((action) => ({ ...action })),
    bestAiTurn: [...move.bestAiTurn]
  })),
  bestPits: [...result.bestPits]
})

/** One synchronous prompt build owns this small result cache. No search table,
 * position or result is retained globally. Eligible thresholds share work only
 * after the solver validates them; original logical visit counts are preserved.
 */
export function createEndgameTieRequest() {
  const results = new Map<string, EndgameTieResult>()
  let searches = 0,
    hits = 0
  const memo: RequestMemo = {
    lookup(key) {
      const result = results.get(key)
      if (result) {
        hits++
        return copyResult(result)
      }
      searches++
      return undefined
    },
    remember(key, result) {
      if (results.size === MAX_REQUEST_RESULTS && !results.has(key)) {
        const oldest = results.keys().next().value
        if (oldest !== undefined) results.delete(oldest)
      }
      results.set(key, copyResult(result))
    }
  }
  const solve: EndgameTieSolver = (game, candidates, options = {}) =>
    runEndgameSearch(game, candidates, options, memo)
  return {
    solve,
    stats: () => ({ searches, hits, entries: results.size })
  }
}

type Entry = { score: number; flag: "exact" | "lower" | "upper"; pit: number }
class NodeLimit extends Error {}
const keyOf = (board: Board, side: Side) =>
  String.fromCharCode(
    side === "ai" ? 1 : 0,
    board[0],
    board[1],
    board[2],
    board[3],
    board[4],
    board[5],
    board[7],
    board[8],
    board[9],
    board[10],
    board[11],
    board[12]
  )

/** Compare bounded-priority ties by exact final margin in small endgames.
 * Stores do not affect future legal actions: each edge records its secured
 * AI-minus-Human delta, and the TT stores only the remaining pits and side.
 * Every continuation reaches the terminal sweep; a secured majority is not a
 * cutoff. A resource limit discards the entire comparison, never ranks partials.
 */
export function solveEndgameTies(
  game: Game,
  candidates: readonly number[],
  options: EndgameTieOptions = {}
): EndgameTieResult {
  return runEndgameSearch(game, candidates, options)
}

function runEndgameSearch(
  game: Game,
  candidates: readonly number[],
  options: EndgameTieOptions,
  memo?: RequestMemo
): EndgameTieResult {
  const maxRemainingSeeds = options.maxRemainingSeeds ?? 22
  const maxNodes = options.maxNodes ?? 1_000_000
  const maxTableEntries = options.maxTableEntries ?? 75_000
  if (
    !Number.isSafeInteger(maxRemainingSeeds) ||
    maxRemainingSeeds < 0 ||
    maxRemainingSeeds > 24 ||
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    !Number.isSafeInteger(maxTableEntries) ||
    maxTableEntries < 1
  ) {
    throw new RangeError(
      "Choose an endgame threshold up to 24 and positive integer resource limits."
    )
  }
  if (
    game.board.length !== 14 ||
    game.board.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 48
    )
  ) {
    throw new Error("A Kalah board needs fourteen nonnegative seed counts.")
  }
  const remainingSeeds = game.board.reduce(
    (sum, value, pit) => sum + (pit === 6 || pit === 13 ? 0 : value),
    0
  )
  let nodes = 0
  const incomplete = (
    reason: EndgameTieResult["reason"]
  ): EndgameTieResult => ({
    complete: false,
    reason,
    remainingSeeds,
    nodes,
    moves: [],
    bestPits: []
  })
  if (game.status !== "playing" || game.turn !== "ai")
    return incomplete("not-playing")
  const allowed = legalMoves(game.board, "ai")
  if (
    new Set(candidates).size !== candidates.length ||
    candidates.some((pit) => !allowed.includes(pit))
  ) {
    throw new Error("Endgame candidates must be distinct legal AI pits.")
  }
  if (candidates.length <= 1) return incomplete("single-choice")
  if (remainingSeeds > maxRemainingSeeds) return incomplete("too-many-seeds")

  // The threshold only controls eligibility. Once qualified, 22 and 24 (for
  // example) execute identical work with the same position, order and limits.
  const requestKey = memo
    ? JSON.stringify([
        game.board,
        game.turn,
        game.status,
        candidates,
        maxNodes,
        maxTableEntries
      ])
    : undefined
  const previous =
    requestKey === undefined ? undefined : memo?.lookup(requestKey)
  if (previous) return previous
  const rememberResult = (result: EndgameTieResult) => {
    if (requestKey !== undefined) memo?.remember(requestKey, result)
    return result
  }

  const table = new Map<string, Entry>()
  const insertionOrder: string[] = []
  let eviction = 0
  const remember = (key: string, entry: Entry) => {
    if (!table.has(key)) {
      if (table.size >= maxTableEntries) {
        table.delete(insertionOrder[eviction])
        insertionOrder[eviction] = key
        eviction = (eviction + 1) % maxTableEntries
      } else insertionOrder.push(key)
    }
    table.set(key, entry)
  }
  const step = (board: Board, side: Side, pit: number) => {
    const next = sow(board, side, pit)
    const delta = next.board[13] - next.board[6]
    next.board[6] = next.board[13] = 0
    return {
      board: next.board,
      side: next.turn,
      terminal: next.status !== "playing",
      delta,
      pit,
      bonus: next.extraTurn,
      captured: next.captured
    }
  }
  function search(
    board: Board,
    side: Side,
    terminal: boolean,
    alpha: number,
    beta: number
  ): number {
    if (nodes >= maxNodes) throw new NodeLimit()
    nodes++
    if (terminal) return 0
    const key = keyOf(board, side)
    const originalAlpha = alpha,
      originalBeta = beta
    const cached = table.get(key)
    if (cached) {
      if (cached.flag === "exact") return cached.score
      if (cached.flag === "lower") alpha = Math.max(alpha, cached.score)
      else beta = Math.min(beta, cached.score)
      if (alpha >= beta) return cached.score
    }
    const moves = legalMoves(board, side)
      .map((pit) => step(board, side, pit))
      .sort((a, b) => {
        const aHash = a.pit === cached?.pit,
          bHash = b.pit === cached?.pit
        if (aHash !== bHash) return Number(bHash) - Number(aHash)
        if (a.bonus !== b.bonus) return Number(b.bonus) - Number(a.bonus)
        if (a.captured !== b.captured) return b.captured - a.captured
        return side === "ai" ? b.delta - a.delta : a.delta - b.delta
      })
    if (!moves.length)
      throw new Error("A live endgame position has no legal move.")
    let best = side === "ai" ? -Infinity : Infinity
    let bestPit = moves[0].pit
    for (const move of moves) {
      const score =
        move.delta +
        search(
          move.board,
          move.side,
          move.terminal,
          alpha - move.delta,
          beta - move.delta
        )
      if (side === "ai" ? score > best : score < best) {
        best = score
        bestPit = move.pit
      }
      if (side === "ai") alpha = Math.max(alpha, best)
      else beta = Math.min(beta, best)
      if (alpha >= beta) break
    }
    remember(key, {
      score: best,
      flag:
        best <= originalAlpha
          ? "upper"
          : best >= originalBeta
            ? "lower"
            : "exact",
      pit: bestPit
    })
    return best
  }
  const initial = game.board.slice()
  const alreadySecured = initial[13] - initial[6]
  const totalSeeds = initial.reduce((sum, value) => sum + value, 0)
  initial[6] = initial[13] = 0
  try {
    const moves: EndgameTieMove[] = []
    for (const pit of candidates) {
      const first = step(initial, "ai", pit)
      const finalMargin =
        alreadySecured +
        first.delta +
        search(first.board, first.side, first.terminal, -Infinity, Infinity)
      const principalLine: EndgameTieMove["principalLine"] = [
        { side: "ai", pit }
      ]
      let current = first
      while (!current.terminal && current.side === "ai") {
        search(current.board, current.side, false, -Infinity, Infinity)
        const exact = table.get(keyOf(current.board, current.side))
        if (!exact || exact.flag !== "exact")
          throw new Error("An exact endgame continuation is unavailable.")
        principalLine.push({ side: current.side, pit: exact.pit })
        current = step(current.board, current.side, exact.pit)
      }
      const bestAiTurn: number[] = []
      for (const action of principalLine) {
        if (action.side !== "ai") break
        bestAiTurn.push(action.pit)
      }
      moves.push({
        pit,
        finalMargin,
        aiStore: (totalSeeds + finalMargin) / 2,
        humanStore: (totalSeeds - finalMargin) / 2,
        principalLine,
        bestAiTurn
      })
    }
    const best = Math.max(...moves.map((move) => move.finalMargin))
    return rememberResult({
      complete: true,
      reason: "solved",
      remainingSeeds,
      nodes,
      moves,
      bestPits: moves
        .filter((move) => move.finalMargin === best)
        .map((move) => move.pit)
    })
  } catch (error) {
    if (error instanceof NodeLimit)
      return rememberResult(incomplete("node-limit"))
    throw error
  }
}
