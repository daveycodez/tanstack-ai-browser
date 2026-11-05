import assert from "node:assert/strict"
import { test } from "node:test"
import { stableMoveOrder } from "./move-order.ts"

const moves = ["a7a5", "a7a6", "b8c6", "b8a6", "e7e5", "e7e6", "g8f6", "g8h6"].map(id => ({ id }))
test("same game and position keep an exact order without mutating inputs", () => {
  const before = JSON.stringify(moves)
  assert.deepEqual(stableMoveOrder(moves, "game-1"), stableMoveOrder([...moves].reverse(), "game-1"))
  assert.deepEqual(new Set(stableMoveOrder(moves, "game-1")), new Set(moves))
  assert.equal(JSON.stringify(moves), before)
})
test("new games vary presentation while changing legal moves preserves survivors", () => {
  const openings = new Set(Array.from({ length: 12 }, (_, i) => stableMoveOrder(moves, `game-${i}`)[0].id))
  assert.ok(openings.size >= 4)
  const original = stableMoveOrder(moves, "game-1")
  const changed = stableMoveOrder([...moves.slice(1), { id: "d7d5" }], "game-1")
  assert.deepEqual(changed.filter(move => move.id !== "d7d5"), original.filter(move => move.id !== "a7a5"))
})
