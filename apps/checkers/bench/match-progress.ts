import type { GameStatus } from '../src/lib/checkers.ts'

type MatchResult = { policy: 'model' | 'cake'; status: GameStatus | 'capped' | 'error' | 'stopped' }
/** Strength-study updates exclude self-play controls, unfinished play, and errors from W/L/D. */
export function formatMatchScore(traces: readonly MatchResult[]): string {
  const games = traces.filter(trace => trace.policy === 'model')
  const wins = games.filter(trace => trace.status === 'ai-won').length
  const losses = games.filter(trace => trace.status === 'human-won').length
  const draws = games.filter(trace => trace.status === 'draw').length
  const unfinished = games.filter(trace => trace.status === 'capped').length
  const errors = games.filter(trace => trace.status === 'error' || trace.status === 'stopped').length
  return `AI ${wins}W-${losses}L-${draws}D${unfinished ? `; ${unfinished} unfinished` : ''}${errors ? `; ${errors} errors/stopped` : ''}`
}
