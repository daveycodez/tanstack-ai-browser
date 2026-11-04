import { createMoveSearch, legalMoves } from './checkers.ts'
import type { Game, Move } from './checkers.ts'

/** A short, exact finish only in one/two pieces versus one; not a general engine. */
export function shortEndgameWins(game: Game, moves: readonly Move[] = legalMoves(game.board, 'ai')): Set<string> {
  if (game.status !== 'playing' || game.turn !== 'ai' || game.board.filter(p => p?.side === 'human').length !== 1 || game.board.filter(p => p?.side === 'ai').length > 2) return new Set()
  const search = createMoveSearch()
  const wins = (position: Game, ownTurns: number): boolean => {
    if (position.status === 'ai-won') return true
    if (position.status !== 'playing') return false
    const legal = search.moves(position.board, position.turn)
    return position.turn === 'ai'
      ? ownTurns > 0 && legal.some(move => wins(search.apply(position, move.id), ownTurns - 1))
      : legal.length > 0 && legal.every(move => wins(search.apply(position, move.id), ownTurns))
  }
  return new Set(moves.filter(move => wins(search.apply(game, move.id), 3)).map(move => move.id))
}
