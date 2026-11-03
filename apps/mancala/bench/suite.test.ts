import assert from "node:assert/strict"
import test from "node:test"
import { CASES, gameForCase } from "./cases.ts"
import { auditSuite } from "./audit.ts"
import { completeTurns, expectedForCase, objectiveValues } from "./reference.ts"
import { sow } from "../src/lib/mancala.ts"

function getCase(id: string) {
  const fixture = CASES.find((item) => item.id === id)
  assert.ok(fixture, `Missing fixture: ${id}`)
  return fixture
}

test("every frozen objective matches an exhaustive complete-turn audit", () => {
  const audit = auditSuite()
  assert.equal(audit.cases, 17)
  assert.equal(audit.scored, 14)
  assert.equal(audit.holdout, 3)
  assert.equal(new Set(CASES.map((item) => item.category)).size, 6)
})
test("bonus-turn continuations contribute to the grade", () => {
  const fixture = getCase("chain-into-capture")
  const first = sow(fixture.board, "ai", 11)
  assert.equal(first.extraTurn, true)
  assert.equal(first.board[13] - fixture.board[13], 1)
  assert.equal(
    objectiveValues(fixture).find((item) => item.pit === 11)?.value,
    15
  )
  assert.equal(
    Math.max(
      ...completeTurns(first.board, "ai").map(
        (end) => end.board[13] - fixture.board[13]
      )
    ),
    15
  )
})
test("equal immediate captures are distinguished by the full reply", () => {
  const fixture = getCase("equal-captures")
  assert.equal(sow(fixture.board, "ai", 8).captured, 4)
  assert.equal(sow(fixture.board, "ai", 9).captured, 4)
  assert.equal(sow(fixture.board, "ai", 10).captured, 4)
  assert.deepEqual(expectedForCase(fixture), [9])
})
test("all tied terminal wins are accepted", () => {
  const fixture = getCase("tied-wins")
  assert.deepEqual(expectedForCase(fixture), [7, 9])
  assert.ok(fixture.expectedPits)
  for (const pit of fixture.expectedPits)
    assert.equal(sow(fixture.board, "ai", pit).status, "ai-won")
})
test("a draw is scored above the bounded losing alternatives", () => {
  const fixture = getCase("save-the-draw")
  assert.equal(sow(fixture.board, "ai", 7).status, "draw")
  assert.deepEqual(expectedForCase(fixture), [7, 10, 12])
})
test("the benchmark positions never share mutable board or history state", () => {
  const first = gameForCase(CASES[0])
  const second = gameForCase(CASES[0])
  first.board[0] = 0
  assert.equal(second.board[0], 4)
  assert.equal(CASES[0].board[0], 4)
  assert.notEqual(first.history, second.history)
  assert.equal(first.turn, "ai")
})
