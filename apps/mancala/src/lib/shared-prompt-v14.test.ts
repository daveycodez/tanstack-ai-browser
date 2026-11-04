import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt-v14.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
const position = (board: number[]) => ({
  ...createGame(),
  turn: "ai" as const,
  board
})
test("a unique shallow preference cannot conceal a proved draw in another legal action", () => {
  const game = position([2, 0, 3, 0, 1, 0, 17, 3, 1, 0, 1, 0, 0, 20])
  const old = buildMovePrompt(game, undefined, "shared-v13")
  const current = buildMovePrompt(game)
  assert.deepEqual(old.priorityPits, [10])
  assert.deepEqual(current.priorityPits, [7])
  assert.equal(current.finalComparison?.complete, true)
  assert.equal(current.recommendedAction, "Sow 3 seeds from AI pit 1")
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
  assert.equal(
    current.report?.actions.find((a) => a.preferred)?.resultForAI,
    "DRAW"
  )
  assert.equal(
    current.report?.actions.find((a) => a.label.endsWith("pit 4"))?.resultForAI,
    "LOSS"
  )
  assert.equal(
    buildMovePrompt(game, legalMoves(game.board, "ai").toReversed())
      .recommendedAction,
    current.recommendedAction
  )
  assert.match(current.prompt, /Every legal action has been solved/)
  assert.equal(current.prompt.match(/RECOMMENDED AI ACTION:/g)?.length, 1)
})
test("small-endgame proof preserves the old nineteen scoped objectives and every legal label", () => {
  for (const fixture of CASES.filter(
    (c) => !c.id.startsWith("sol-match-") && !c.id.startsWith("matched-")
  )) {
    const game = gameForCase(fixture),
      current = buildMovePrompt(game)
    const old = buildMovePrompt(game, undefined, "shared-v13")
    assert.deepEqual(
      current.choices.map((c) => [c.id, c.label]),
      old.choices.map((c) => [c.id, c.label]),
      fixture.id
    )
    const recommended = current.choices.find(
      (c) => c.label === current.recommendedAction
    )
    if (fixture.expectedPits)
      assert.ok(
        recommended && fixture.expectedPits.includes(recommended.id),
        fixture.id
      )
    if (current.finalComparison && !current.finalComparison.complete) {
      assert.deepEqual(current.choices, old.choices, fixture.id)
      assert.equal(current.recommendedAction, old.recommendedAction, fixture.id)
    }
  }
})
