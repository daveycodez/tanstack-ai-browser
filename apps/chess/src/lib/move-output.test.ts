import assert from "node:assert/strict"
import { test } from "node:test"
import { legalMoves, newGame, fromFen } from "./chess.ts"
import { moveOutputSchema } from "./move-output.ts"

test("structured game output preserves every legal choice and excludes unrelated IDs and fields", () => {
  const ids = legalMoves(newGame()).map((m) => m.id),
    schema = moveOutputSchema(ids)
  assert.deepEqual(schema.shape.moveId.options, ids)
  for (const moveId of ids)
    assert.deepEqual(schema.parse({ moveId }), { moveId })
  for (const value of [
    { moveId: "e2e5" },
    { moveId: "pawn e2-e4" },
    { moveId: "e2e4", reason: "because" },
    {}
  ])
    assert.equal(schema.safeParse(value).success, false)
  assert.throws(() => moveOutputSchema([]))
})
test("promotion alternatives remain distinct legal schema choices", () => {
  const ids = legalMoves(fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 1")).map(
      (m) => m.id
    ),
    schema = moveOutputSchema(ids)
  for (const piece of ["q", "r", "b", "n"])
    assert.equal(schema.safeParse({ moveId: `a7a8${piece}` }).success, true)
  assert.equal(schema.safeParse({ moveId: "a7a8" }).success, false)
})
