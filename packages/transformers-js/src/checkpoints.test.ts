import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { checkpointsToDrop } from "./checkpoints.js"

const MB = 1e6
/** The dropped indexes, sorted, per list. */
const dropped = (
  lists: Array<Array<number>>,
  perList: number,
  budget: number
) =>
  checkpointsToDrop(lists, perList, budget).map((d) =>
    [...d].sort((a, b) => a - b)
  )

describe("checkpointsToDrop", () => {
  test("keeps the first and the latest past the count", () => {
    assert.deepEqual(dropped([Array(8).fill(1)], 6, Infinity), [[1, 2]])
  })

  test("LFM-sized checkpoints: six caches of six fit the budget, as before", () => {
    const lists = Array.from({ length: 6 }, () => Array(7).fill(0.3 * MB))
    assert.deepEqual(
      dropped(lists, 6, 64 * MB),
      lists.map(() => [1])
    )
  })

  test("past the budget, the least recently used cache's middles go first", () => {
    const lists = [Array(4).fill(10 * MB), Array(4).fill(10 * MB)]
    assert.deepEqual(dropped(lists, 6, 60 * MB), [[], [1, 2]])
    assert.deepEqual(dropped(lists, 6, 50 * MB), [[1], [1, 2]])
  })

  test("then other caches' latest, then their first", () => {
    const lists = [
      Array(3).fill(10 * MB),
      [10 * MB, 10 * MB],
      [10 * MB, 10 * MB]
    ]
    assert.deepEqual(dropped(lists, 6, 50 * MB), [[1], [], [1]])
    assert.deepEqual(dropped(lists, 6, 40 * MB), [[1], [1], [1]])
    assert.deepEqual(dropped(lists, 6, 30 * MB), [[1], [1], [0, 1]])
    assert.deepEqual(dropped(lists, 6, 20 * MB), [[1], [0, 1], [0, 1]])
  })

  test("the latest cache keeps its first and latest whatever the budget", () => {
    const lists = [Array(5).fill(10 * MB), [10 * MB]]
    assert.deepEqual(dropped(lists, 6, 0), [[1, 2, 3], [0]])
  })

  test("Qwen3.5-sized checkpoints stay within the budget", () => {
    const lists = Array.from({ length: 6 }, () => Array(6).fill(10.3 * MB))
    const drops = checkpointsToDrop(lists, 6, 64 * MB)
    const kept = lists.flatMap((sizes, i) =>
      sizes.filter((_, k) => !drops[i].has(k))
    )
    assert.ok(kept.reduce((a, b) => a + b, 0) <= 64 * MB)
    // The latest cache keeps its first and latest, four others their first.
    assert.deepEqual(
      drops.map((d) => 6 - d.size),
      [2, 1, 1, 1, 1, 0]
    )
  })
})
