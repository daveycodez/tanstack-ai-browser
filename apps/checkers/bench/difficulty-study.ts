/**
 * Whole games of the model against a fixed stand-in for a casual player, to compare prompt
 * versions by difficulty. The stand-in plays the best move of a two-ply material search
 * (captures settled) with random ties, and any legal move the rest of the time.
 *
 * In the dev server's console: `(await import("/bench/difficulty-study.ts")).study(["shared-v20", "shared-v21"], [1, 2, 3])`,
 * then read `__study.reports`. No game is saved and nothing is downloaded.
 */
import { applyMove, legalMoves, newGame, previewBoard } from "../src/lib/checkers.ts"
import type { Board, Game, Side } from "../src/lib/checkers.ts"
import { annotateMoves, materialBalance } from "../src/lib/move-outcomes.ts"
import { avoidableLosses } from "../src/lib/shared-prompt.ts"
import type { PromptVersion } from "../src/lib/shared-prompt.ts"
import { stableMoveOrder } from "../src/lib/move-order.ts"
import { chooseAiMove } from "../src/lib/ai.ts"

const random = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296

// Material search from the stand-in's view, settling captures.
function search(board: Board, side: Side, depth: number): number {
  const moves = legalMoves(board, side)
  if (!moves.length) return side === "human" ? -50 : 50
  if (depth <= 0 && (!moves.some(move => move.captures.length) || depth < -6)) return -materialBalance(board)
  let best = side === "human" ? -Infinity : Infinity
  for (const move of moves) {
    const value = search(previewBoard(board, move.path), side === "human" ? "ai" : "human", depth - 1)
    best = side === "human" ? Math.max(best, value) : Math.min(best, value)
  }
  return best
}

/** A chosen action by the guards: among the best results, a hidden one-point slip, or a blunder. */
export type Category = "sound" | "slip" | "blunder" | "forced"
export function categorize(game: Game, moveId: string): Category {
  const moves = legalMoves(game.board, "ai")
  if (moves.length < 2) return "forced"
  const annotated = annotateMoves(game, moves, true, true)
  const chosen = (move: { id: string }) => move.id === moveId
  return !avoidableLosses(annotated).some(chosen) ? "sound" : avoidableLosses(annotated, true).some(chosen) ? "blunder" : "slip"
}

export type GameReport = { version: string; seed: number; status: string; plies: number; balance: number; counts: Record<string, number>; seconds: number; slips: string[] }
/** One game. `skill`: how often the stand-in plays its best move. */
export async function playGame(version: PromptVersion, seed: number, skill = 0.85): Promise<GameReport> {
  const rnd = random(seed * 7919 + 17)
  const pick = <T,>(items: T[]) => items[Math.floor(rnd() * items.length)]
  let game: Game = { ...newGame(seed % 2 ? "white" : "black"), sessionId: `study-${version}-${seed}-${Date.now()}` }
  const counts: Record<string, number> = {}, slips: string[] = []
  const started = performance.now()
  let plies = 0
  while (game.status === "playing" && plies++ < 220) {
    if (game.turn === "human") {
      const position = game
      const scored = legalMoves(position.board, "human").map(move => ({ move, value: search(applyMove(position, move.id).board, "ai", 2) }))
      const best = Math.max(...scored.map(item => item.value))
      game = applyMove(game, (rnd() < skill ? pick(scored.filter(item => item.value === best)) : pick(scored)).move.id)
    } else {
      const ids = legalMoves(game.board, "ai").map(move => move.id)
      // The same card order for every version of a seed.
      const id = ids.length === 1 ? ids[0] : await chooseAiMove(game, new AbortController(), undefined, undefined, { promptVersion: version, moveOrder: stableMoveOrder(`study-${seed}`, ids) })
      const category = categorize(game, id)
      counts[category] = (counts[category] ?? 0) + 1
      if (category !== "sound" && category !== "forced") slips.push(`${plies}:${category}:${id}`)
      game = applyMove(game, id)
    }
  }
  return { version, seed, status: game.status, plies, balance: materialBalance(game.board), counts, seconds: Math.round((performance.now() - started) / 1000), slips }
}

export async function study(versions: PromptVersion[], seeds: number[], skill = 0.85) {
  const state = ((globalThis as { __study?: { reports: GameReport[]; done: boolean; error?: string; current?: string } }).__study = { reports: [], done: false })
  try {
    // Alternate versions seed by seed, so drift over the run is shared.
    for (const seed of seeds) for (const version of versions) {
      state.current = `${version} seed ${seed}`
      state.reports.push(await playGame(version, seed, skill))
    }
  } catch (error) { state.error = error instanceof Error ? error.message : String(error) }
  state.done = true
  return state
}
