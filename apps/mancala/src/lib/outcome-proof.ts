import { legalMoves, sow } from "./mancala.ts"
import type { Board, Game, GameStatus, Side } from "./mancala.ts"

export const GAME_OUTCOME_PROOF_VERSION = "exact-outcome-v1" as const
export type GameOutcome = "ai-win" | "draw" | "human-win"
export type GameOutcomeProofOptions = {
  maxRemainingSeeds?: number
  maxNodes?: number
  maxTableEntries?: number
}
export type GameOutcomeProofResult = {
  complete: boolean
  reason:
    "solved" | "not-playing" | "single-choice" | "too-many-seeds" | "node-limit"
  remainingSeeds: number
  nodes: number
  maxTableEntriesUsed: number
  moves: { pit: number; outcome: GameOutcome }[]
  bestPits: number[]
}

type Value = -1 | 0 | 1
type Entry = { value: Value; flag: "exact" | "lower" | "upper"; pit: number }
class NodeLimit extends Error {}
const keyOf = (board: Board, side: Side) => `${board.join(",")}:${side}`
const outcomeOf = (value: Value): GameOutcome =>
  value > 0 ? "ai-win" : value < 0 ? "human-win" : "draw"

/** Prove only win/draw/loss for EVERY legal AI action under optimal counterplay.
 * Full-board transpositions include both stores: a secured majority changes the
 * outcome even when the remaining pits and player are identical. Leaves are
 * terminal sweeps or strictly more than 24 secured seeds, never depth/heuristic
 * evaluations. A single global visit limit covers all roots and cached visits.
 * Each root starts with a full [-2, 2] window, so a returned class is exact.
 * Any exhaustion discards the entire comparison, including already proved roots.
 */
export function solveGameOutcomes(
  game: Game,
  moves?: readonly number[],
  options: GameOutcomeProofOptions = {}
): GameOutcomeProofResult {
  const maxRemainingSeeds = options.maxRemainingSeeds ?? 24
  const maxNodes = options.maxNodes ?? 1_000_000
  const maxTableEntries = options.maxTableEntries ?? 75_000
  if (
    !Number.isSafeInteger(maxRemainingSeeds) ||
    maxRemainingSeeds < 0 ||
    maxRemainingSeeds > 24 ||
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    !Number.isSafeInteger(maxTableEntries) ||
    maxTableEntries < 1 ||
    maxTableEntries > 75_000
  )
    throw new RangeError(
      "Choose a seed threshold up to 24, a positive integer node limit, and one to 75000 table entries."
    )
  if (
    !Array.isArray(game.board) ||
    game.board.length !== 14 ||
    [...game.board].some(
      (seeds) => !Number.isSafeInteger(seeds) || seeds < 0 || seeds > 48
    ) ||
    game.board.reduce((total, seeds) => total + seeds, 0) !== 48
  )
    throw new Error(
      "A Kalah proof needs fourteen nonnegative seed counts totaling 48."
    )
  if (
    (game.turn !== "ai" && game.turn !== "human") ||
    !["playing", "ai-won", "human-won", "draw"].includes(game.status)
  )
    throw new Error("A Kalah proof needs a valid player and game status.")
  const remainingSeeds = 48 - game.board[6] - game.board[13]
  let nodes = 0
  let maxTableEntriesUsed = 0
  const incomplete = (
    reason: GameOutcomeProofResult["reason"]
  ): GameOutcomeProofResult => ({
    complete: false,
    reason,
    remainingSeeds,
    nodes,
    maxTableEntriesUsed,
    moves: [],
    bestPits: []
  })
  if (game.status !== "playing" || game.turn !== "ai")
    return incomplete("not-playing")
  const allowed = legalMoves(game.board, "ai")
  if (!allowed.length)
    throw new Error("A playing Kalah board must have seeds on both sides.")
  const candidates = moves ?? allowed
  if (
    new Set(candidates).size !== candidates.length ||
    candidates.some((pit) => !allowed.includes(pit))
  )
    throw new Error("Outcome choices must be distinct legal AI pits.")
  if (candidates.length !== allowed.length)
    throw new Error(
      "Every legal AI pit is required for a global outcome proof."
    )
  if (candidates.length === 1) return incomplete("single-choice")
  if (remainingSeeds > maxRemainingSeeds) return incomplete("too-many-seeds")

  const table = new Map<string, Entry>()
  // One key per slot. Updating an existing entry does not extend the FIFO ring.
  const ring: string[] = []
  let nextSlot = 0
  const remember = (key: string, entry: Entry) => {
    if (!table.has(key)) {
      if (table.size === maxTableEntries) table.delete(ring[nextSlot])
      ring[nextSlot] = key
      nextSlot = (nextSlot + 1) % maxTableEntries
    }
    table.set(key, entry)
    maxTableEntriesUsed = Math.max(maxTableEntriesUsed, table.size)
  }
  function search(
    board: Board,
    side: Side,
    status: GameStatus,
    alpha: number,
    beta: number
  ): Value {
    if (nodes >= maxNodes) throw new NodeLimit()
    nodes++
    if (status !== "playing") return Math.sign(board[13] - board[6]) as Value
    if (board[13] > 24) return 1
    if (board[6] > 24) return -1
    const key = keyOf(board, side)
    const originalAlpha = alpha,
      originalBeta = beta
    const cached = table.get(key)
    if (cached) {
      if (cached.flag === "exact") return cached.value
      if (cached.flag === "lower") alpha = Math.max(alpha, cached.value)
      else beta = Math.min(beta, cached.value)
      if (alpha >= beta) return cached.value
    }
    const children = legalMoves(board, side)
      .map((pit) => ({ pit, next: sow(board, side, pit) }))
      .sort(
        (a, b) =>
          Number(b.pit === cached?.pit) - Number(a.pit === cached?.pit) ||
          Number(b.next.extraTurn) - Number(a.next.extraTurn) ||
          b.next.captured - a.next.captured
      )
    if (!children.length)
      throw new Error("A live outcome-proof position has no legal move.")
    let best = side === "ai" ? -2 : 2
    let bestPit = children[0].pit
    for (const { pit, next } of children) {
      const value = search(next.board, next.turn, next.status, alpha, beta)
      if (side === "ai" ? value > best : value < best) {
        best = value
        bestPit = pit
      }
      if (side === "ai") alpha = Math.max(alpha, best)
      else beta = Math.min(beta, best)
      // The best possible outcome is a proof even when other children remain.
      if (alpha >= beta || (side === "ai" ? best === 1 : best === -1)) break
    }
    const value = best as Value
    remember(key, {
      value,
      pit: bestPit,
      flag:
        value <= originalAlpha
          ? "upper"
          : value >= originalBeta
            ? "lower"
            : "exact"
    })
    return value
  }
  try {
    const proved = candidates.map((pit) => {
      const next = sow(game.board, "ai", pit)
      return { pit, value: search(next.board, next.turn, next.status, -2, 2) }
    })
    const best = Math.max(...proved.map((move) => move.value))
    return {
      complete: true,
      reason: "solved",
      remainingSeeds,
      nodes,
      maxTableEntriesUsed,
      moves: proved.map(({ pit, value }) => ({
        pit,
        outcome: outcomeOf(value)
      })),
      bestPits: proved
        .filter((move) => move.value === best)
        .map((move) => move.pit)
    }
  } catch (error) {
    if (error instanceof NodeLimit) return incomplete("node-limit")
    throw error
  }
}
