import { legalMoves, sow } from "../src/lib/mancala.ts"
import type { Board, GameStatus, Side } from "../src/lib/mancala.ts"

type Entry = { value: number; kind: "exact" | "lower" | "upper" }
const results = new Map<string, { pit: number; value: number }[]>()

/** Full-board/store oracle for small teaching endgames. This is independent of
 * production's store-neutral tie solver and has no depth or majority cutoff.
 * An exhausted safety budget throws; a partial score is never a benchmark grade.
 */
export function terminalMarginValues(
  board: Board,
  maxNodes = 5_000_000
): { pit: number; value: number }[] {
  const inputKey = board.join(",")
  const cached = maxNodes === 5_000_000 ? results.get(inputKey) : undefined
  if (cached) return cached.map((value) => ({ ...value }))
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1)
    throw new RangeError("Choose a positive terminal audit node limit.")
  const table = new Map<string, Entry>()
  let nodes = 0
  function visit(
    position: Board,
    side: Side,
    status: GameStatus,
    alpha: number,
    beta: number
  ): number {
    if (++nodes > maxNodes)
      throw new Error(
        "Terminal audit node limit exceeded; no partial result may be graded."
      )
    if (status !== "playing") return position[13] - position[6]
    const key = `${position.join(",")}:${side}`
    const entry = table.get(key)
    if (entry) {
      if (entry.kind === "exact") return entry.value
      if (entry.kind === "lower") alpha = Math.max(alpha, entry.value)
      else beta = Math.min(beta, entry.value)
      if (alpha >= beta) return entry.value
    }
    const originalAlpha = alpha,
      originalBeta = beta
    let best = side === "ai" ? -49 : 49
    const children = legalMoves(position, side)
      .map((pit) => sow(position, side, pit))
      .sort(
        (a, b) =>
          Number(b.extraTurn) - Number(a.extraTurn) || b.captured - a.captured
      )
    for (const child of children) {
      const value = visit(child.board, child.turn, child.status, alpha, beta)
      if (side === "ai") {
        best = Math.max(best, value)
        alpha = Math.max(alpha, best)
      } else {
        best = Math.min(best, value)
        beta = Math.min(beta, best)
      }
      if (alpha >= beta) break
    }
    if (table.size < 1_000_000)
      table.set(key, {
        value: best,
        kind:
          best <= originalAlpha
            ? "upper"
            : best >= originalBeta
              ? "lower"
              : "exact"
      })
    return best
  }
  const values = legalMoves(board, "ai").map((pit) => {
    const next = sow(board, "ai", pit)
    return { pit, value: visit(next.board, next.turn, next.status, -49, 49) }
  })
  if (maxNodes === 5_000_000) results.set(inputKey, values)
  return values.map((value) => ({ ...value }))
}
