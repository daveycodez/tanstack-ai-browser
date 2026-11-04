import { applyMove, legalMoves } from '../src/lib/checkers.ts'
import type { Board, Game } from '../src/lib/checkers.ts'

export const CAKE_URL = 'http://127.0.0.1:3013'
export const CAKE_DEPTH = 7
export type CakeMetadata = { name: string; repository: string; revision: string; configuration: string; history: string }
export type CakeResult = { moveId: string; score: number; requestedDepth: number; completedDepth: number; nodes: number; cpuSeconds: number; provenance: CakeMetadata }
export function cakePosition(board: Board, turn: Game['turn']): number[] {
  const bits = [0, 0, 0, 0]
  board.forEach((piece, index) => {
    if (!piece) return
    const bit = 2 ** (4 * (7 - Math.floor(index / 8)) + Math.floor((index % 8) / 2))
    const field = piece.side === 'human' ? piece.king ? 1 : 0 : piece.king ? 3 : 2
    bits[field] = (bits[field] | bit) >>> 0
  })
  return [...bits, turn === 'human' ? 2 : 1]
}
export function matchCakeMove(game: Game, result: { successor: number[]; legalSuccessors: number[][] }): string {
  const successors = legalMoves(game.board, game.turn).map(move => ({ id: move.id, key: JSON.stringify(cakePosition(applyMove(game, move.id).board, game.turn === 'ai' ? 'human' : 'ai')) }))
  const actual = new Set(successors.map(move => move.key)), native = new Set(result.legalSuccessors.map(board => JSON.stringify(board)))
  if (actual.size !== native.size || [...actual].some(key => !native.has(key))) throw new Error('Cake and the application disagree on legal successor states. Comparison stopped.')
  const chosen = successors.find(move => move.key === JSON.stringify(result.successor))
  if (!chosen) throw new Error('Cake chose a successor that is not legal in the application.')
  return chosen.id
}
export async function cakeMetadata(signal?: AbortSignal): Promise<CakeMetadata> {
  const response = await fetch(`${CAKE_URL}/metadata`, { signal })
  if (!response.ok) throw new Error('Start the local Cake benchmark bridge before this comparison.')
  return response.json() as Promise<CakeMetadata>
}
export async function chooseCakeMove(game: Game, signal: AbortSignal, depth = CAKE_DEPTH): Promise<CakeResult> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 25 || depth % 2 !== 1) throw new Error("Cake benchmark depth must be an odd integer from 1 through 25.")
  const response = await fetch(`${CAKE_URL}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([...cakePosition(game.board, game.turn), depth, game.positions.slice(-11, -1).map(key => { const [turn, text] = key.split(':'); return cakePosition([...text].map(piece => piece === '.' ? null : { side: piece.toLowerCase() === 'h' ? 'human' : 'ai', king: piece === piece.toUpperCase() }), turn === 'human' ? 'human' : 'ai') })]), signal })
  const result = await response.json() as { error?: string; successor: number[]; legalSuccessors: number[][]; aborted?: boolean } & Omit<CakeResult, 'moveId'>
  signal.throwIfAborted()
  if (!response.ok || result.error || result.aborted) throw new Error(result.error ?? 'Cake search failed.')
  if (!Number.isInteger(result.completedDepth) || result.completedDepth < 1 || result.completedDepth > depth) throw new Error('Cake reported an invalid completed search depth.')
  return { moveId: matchCakeMove(game, result), score: result.score, requestedDepth: result.requestedDepth, completedDepth: result.completedDepth, nodes: result.nodes, cpuSeconds: result.cpuSeconds, provenance: result.provenance }
}

/** Separate candidate audit through unchanged native MTD(f); units are Cake units, not calibrated centipawns. */
export async function auditCakePosition(game: Game, signal: AbortSignal) {
  const history = game.positions.slice(-11, -1).map(key => { const [turn, text] = key.split(':'); return cakePosition([...text].map(piece => piece === '.' ? null : { side: piece.toLowerCase() === 'h' ? 'human' : 'ai', king: piece === piece.toUpperCase() }), turn === 'human' ? 'human' : 'ai') })
  const response = await fetch(`${CAKE_URL}/rank`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([...cakePosition(game.board, game.turn), CAKE_DEPTH, history]), signal })
  const result = await response.json() as { error?: string; successor: number[]; legalSuccessors: number[][]; rootScores: { successor: number[]; score: number }[] }
  signal.throwIfAborted()
  if (!response.ok || result.error) throw new Error(result.error ?? 'Cake candidate audit failed.')
  matchCakeMove(game, result)
  const moves = legalMoves(game.board, game.turn).map(move => { const next = applyMove(game, move.id); const key = JSON.stringify(cakePosition(next.board, next.turn)); const score = result.rootScores.find(item => JSON.stringify(item.successor) === key)?.score; if (score === undefined || !Number.isFinite(score)) throw new Error('Cake did not score every legal candidate.'); return { id: move.id, score } })
  const best = Math.max(...moves.map(move => move.score))
  return moves.map(move => ({ ...move, regret: best - move.score }))
}
