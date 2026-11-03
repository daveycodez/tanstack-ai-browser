// The same per-action stable ordering used in checkers, with numeric pit IDs.
function priority(sessionId: string, pit: number): number {
  let hash = 2166136261
  for (const character of `${sessionId}:${pit}`)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Vary card order between games without ranking by tactical score or pit label. */
export function orderMovesForGame(
  sessionId: string,
  moves: readonly number[]
): number[] {
  return moves
    .map((pit) => ({ pit, rank: priority(sessionId, pit) }))
    .sort((left, right) => left.rank - right.rank || left.pit - right.pit)
    .map(({ pit }) => pit)
}
