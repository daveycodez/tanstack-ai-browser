import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt.ts"
test("resolved recommendation is an existing equally preferred choice, while the losing legal action remains available", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16]
  }
  const old = buildMovePrompt(game, undefined, "shared-v10"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.analysis, old.analysis)
  assert.deepEqual(current.report, old.report)
  assert.deepEqual(current.priorityPits, [7, 10, 12])
  assert.equal(current.recommendedAction, old.report?.preferredActions[0])
  assert.ok(current.choices.some((c) => c.id === 9))
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
  assert.equal(current.prompt.match(/RECOMMENDED AI ACTION:/g)?.length, 1)
  const reverse = buildMovePrompt(
    game,
    legalMoves(game.board, "ai").toReversed()
  )
  assert.equal(reverse.recommendedAction, "Sow 1 seed from AI pit 1")
  assert.ok(
    reverse.priorityPits?.includes(
      reverse.choices.find((c) => c.label === reverse.recommendedAction)?.id ??
        -1
    )
  )
})
