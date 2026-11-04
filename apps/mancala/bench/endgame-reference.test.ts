import assert from "node:assert/strict"
import test from "node:test"
import { terminalMarginValues } from "./endgame-reference.ts"
const board = [1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13]
test("terminal oracle distinguishes two winning actions by actual final score", () => {
  const before = structuredClone(board)
  assert.deepEqual(terminalMarginValues(board), [
    { pit: 7, value: 4 },
    { pit: 8, value: 8 },
    { pit: 10, value: 2 },
    { pit: 11, value: 12 },
    { pit: 12, value: 2 }
  ])
  assert.deepEqual(board, before)
  const values = terminalMarginValues(board)
  values[0].value = 999
  assert.equal(terminalMarginValues(board)[0].value, 4)
})
test("an incomplete terminal audit cannot silently relax a grade", () => {
  assert.throws(
    () => terminalMarginValues(board, 1),
    /no partial result may be graded/
  )
})
