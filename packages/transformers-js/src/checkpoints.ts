/**
 * Which kept checkpoints to drop. A checkpoint copies a cache's states that
 * can't be cut back (conv and recurrent states) at one length: 0.3 MB for
 * LFM3, but 10.3 MB for Qwen3.5, whose linear-attention layers each keep a
 * whole state matrix. Six caches of six checkpoints each came to ~370 MB of
 * GPU memory for Qwen3.5, so they're held to a budget in bytes as well as a
 * count per cache.
 */

/**
 * The checkpoints to drop, by index per list, so that no list keeps more
 * than `perList` and all of them together fit in `budget` bytes. `lists`
 * holds each cache's checkpoint sizes, most recently used cache first, each
 * ascending by length: the first is usually where the system prompt and
 * tools end (which new chats share), the last where the latest prompt ended.
 *
 * Past `perList`, a list loses its oldest checkpoints after the first. Past
 * the budget go, in order: checkpoints between a list's first and last
 * (oldest first, least recently used list first), the last of each list
 * but the most recent, then their first. The most recent list keeps its
 * first and last whatever the budget.
 */
export function checkpointsToDrop(
  lists: Array<Array<number>>,
  perList: number,
  budget: number
) {
  const drops = lists.map(() => new Set<number>())
  let total = 0
  for (const [i, sizes] of lists.entries()) {
    for (
      let k = 1;
      k < sizes.length - 1 && sizes.length - drops[i].size > perList;
      k++
    ) {
      drops[i].add(k)
    }
    for (const [k, bytes] of sizes.entries()) {
      if (!drops[i].has(k)) total += bytes
    }
  }
  const drop = (i: number, k: number) => {
    if (total <= budget || k < 0 || k >= lists[i].length || drops[i].has(k)) {
      return
    }
    drops[i].add(k)
    total -= lists[i][k]
  }
  for (let i = lists.length - 1; i >= 0; i--) {
    for (let k = 1; k < lists[i].length - 1; k++) drop(i, k)
  }
  for (let i = lists.length - 1; i >= 1; i--) drop(i, lists[i].length - 1)
  for (let i = lists.length - 1; i >= 1; i--) drop(i, 0)
  return drops
}
