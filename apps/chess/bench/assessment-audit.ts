import assert from "node:assert/strict"
import { Chess } from "chess.js"
import { RECORDED_CASES } from "./recorded-cases.ts"
import { assessMove } from "./assess-move.ts"
const play = (board: Chess, id: string) =>
  board.move({
    from: id.slice(0, 2),
    to: id.slice(2, 4),
    ...(id[4] ? { promotion: id[4] } : {})
  })
let reviewed = 0
for (const f of RECORDED_CASES) {
  const board = f.history ? new Chess() : new Chess(f.fen)
  for (const id of f.history ?? []) play(board, id)
  assert.equal(board.fen(), f.fen)
  assert.ok(!board.isGameOver())
  assert.equal(board.turn(), f.humanColor === "black" ? "w" : "b")
  const legal = board
      .moves({ verbose: true })
      .map((m) => m.from + m.to + (m.promotion ?? ""))
      .sort(),
    before = board.fen(),
    review = f.engineReview
  assert.ok(review)
  assert.deepEqual(review.grades.map((g) => g.moveId).sort(), legal)
  for (const order of f.orders) assert.deepEqual([...order].sort(), legal)
  const counts = { acceptable: 0, mistake: 0, uncertain: 0, ungraded: 0 }
  for (const grade of review.grades) {
    assert.equal(grade.bound, false)
    let count = 0
    try {
      for (const id of grade.pv) {
        play(board, id)
        count++
      }
    } finally {
      while (count--) board.undo()
    }
    assert.equal(board.fen(), before)
    counts[assessMove(f, grade.moveId).verdict]++
    reviewed++
  }
  console.log(
    `${f.id}: ${legal.length} legal alternatives, ${JSON.stringify(counts)}`
  )
}
console.log(
  `${RECORDED_CASES.length} real positions, ${reviewed} individually reviewed legal alternatives. No model calls.`
)
