/** A per-move priority, independent of the other legal actions in this position. */
function priority(sessionId: string, moveId: string): number {
  let hash = 2166136261
  for (const character of sessionId + ":" + moveId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  }
  // Mix all bits before ranking: FNV alone correlates similar action ids.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Stable variety between games without reshuffling shared moves on every turn. */
export function orderMovesForGame<T extends { readonly id: string }>(
  sessionId: string,
  moves: readonly T[]
): T[] {
  return moves
    .map(move => ({ move, priority: priority(sessionId, move.id) }))
    .sort((left, right) => left.priority - right.priority || (left.move.id < right.move.id ? -1 : left.move.id > right.move.id ? 1 : 0))
    .map(({ move }) => move)
}

/** The same stable priorities for diagnostics that pass action ids explicitly. */
export function stableMoveOrder(sessionId: string, ids: readonly string[]): string[] {
  return orderMovesForGame(sessionId, ids.map(id => ({ id }))).map(move => move.id)
}
