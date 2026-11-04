/** Presentation priorities only: no chess values, scores, or move filtering.
 * A persisted game ID gives each game a distinct ordering. Adding/removing legal
 * moves preserves every surviving move's relative order, including exact retries.
 */
export function stableMoveOrder<T extends { id: string }>(moves: readonly T[], seed: string): T[] {
  const priority = (id: string) => {
    let hash = 2166136261
    for (const character of seed + ":" + id)
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
    hash ^= hash >>> 16
    hash = Math.imul(hash, 0x7feb352d)
    hash ^= hash >>> 15
    hash = Math.imul(hash, 0x846ca68b)
    return (hash ^ (hash >>> 16)) >>> 0
  }
  return moves.map(move => ({ move, rank: priority(move.id) }))
    .sort((left, right) => left.rank - right.rank ||
      (left.move.id < right.move.id ? -1 : left.move.id > right.move.id ? 1 : 0))
    .map(entry => entry.move)
}
