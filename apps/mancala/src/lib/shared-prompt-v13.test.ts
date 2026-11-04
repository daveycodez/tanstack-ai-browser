import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt-v13.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
const position = (board: number[]) => ({
  ...createGame(),
  turn: "ai" as const,
  board
})
test("the real match's four-turn tie is resolved by terminal proof without hiding the failed legal capture", () => {
  const game = position([1, 1, 0, 8, 0, 1, 17, 1, 1, 0, 0, 9, 1, 8])
  const before = structuredClone(game)
  const old = buildMovePrompt(game, undefined, "shared-v12")
  const current = buildMovePrompt(game)
  assert.deepEqual(old.priorityPits, [8, 12])
  assert.equal(old.endgame?.reason, "too-many-seeds")
  assert.equal(current.tieRefinement?.kind, "exact")
  assert.deepEqual(current.priorityPits, [12])
  assert.equal(current.recommendedAction, "Sow 1 seed from AI pit 6")
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
  assert.ok(current.choices.some((c) => c.id === 8))
  assert.deepEqual(current.report?.preferredActions, [
    current.recommendedAction
  ])
  assert.equal(
    current.report?.actions.find((a) => a.label.endsWith("pit 2"))?.evaluation
      .marginForAI,
    -8
  )
  assert.equal(
    current.report?.actions.find((a) => a.label.endsWith("pit 6"))?.evaluation
      .marginForAI,
    -6
  )
  assert.match(
    current.prompt,
    /Other actions retain their earlier 4-turn evaluation/
  )
  assert.equal(current.prompt.match(/RECOMMENDED AI ACTION:/g)?.length, 1)
  const reversed = buildMovePrompt(
    game,
    legalMoves(game.board, "ai").toReversed()
  )
  assert.equal(reversed.recommendedAction, current.recommendedAction)
  assert.deepEqual(game, before)
})
test("a deeper tactical warning is scoped to the former tie rather than asserted as a solved game", () => {
  const game = position([5, 1, 0, 3, 1, 0, 10, 0, 0, 0, 10, 8, 8, 2])
  const input = buildMovePrompt(game)
  assert.equal(input.tieRefinement?.kind, "bounded")
  assert.deepEqual(input.priorityPits, [10])
  assert.equal(input.recommendedAction, "Sow 10 seeds from AI pit 4")
  assert.match(input.prompt, /8 complete turns \(bounded preview\)/)
  const best = input.report?.actions.find((a) => a.preferred)
  assert.equal(best?.resultForAI, "UNPROVED")
  assert.equal(best?.evaluation.kind, "BOUNDED_TURNS")
  assert.equal(best?.evaluation.turns, 8)
  assert.equal(
    input.report?.actions.find((a) => a.label.endsWith("pit 6"))?.resultForAI,
    "LOSS"
  )
})
test("existing preferred groups and terminal-win/draw policies remain intact on the frozen nineteen boards", () => {
  for (const fixture of CASES.filter(
    (c) => c.id !== "sol-match-preserve-margin"
  )) {
    const game = gameForCase(fixture)
    const old = buildMovePrompt(game, undefined, "shared-v12")
    const current = buildMovePrompt(game)
    assert.deepEqual(current.priorityPits, old.priorityPits, fixture.id)
    assert.equal(current.recommendedAction, old.recommendedAction, fixture.id)
    assert.deepEqual(current.choices, old.choices, fixture.id)
    assert.deepEqual(current.report, old.report, fixture.id)
  }
})

test("subset prompt callers retain their supplied alternatives without claiming an all-legal tie review", () => {
  const game = position([1, 1, 0, 8, 0, 1, 17, 1, 1, 0, 0, 9, 1, 8])
  const old = buildMovePrompt(game, [8, 12], "shared-v12")
  const current = buildMovePrompt(game, [8, 12])
  assert.equal(current.tieRefinement, undefined)
  assert.deepEqual(current.choices, old.choices)
})
