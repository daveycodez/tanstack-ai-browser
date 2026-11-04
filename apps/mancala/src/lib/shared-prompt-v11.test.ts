import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt-v11.ts"
import { resolvePitLabel } from "./move-choice.ts"
test("immediate effects bind capture and bonus facts to exact selectable actions", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16]
  }
  const old = buildMovePrompt(game, undefined, "shared-v10"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.analysis, old.analysis)
  assert.deepEqual(current.priorityPits, old.priorityPits)
  assert.deepEqual(
    current.choices.map((c) => c.id),
    old.choices.map((c) => c.id)
  )
  assert.equal(
    current.choices.find((c) => c.id === 7)?.label,
    "Capture 3 seeds: sow 1 seed from AI pit 1"
  )
  assert.equal(
    current.choices.find((c) => c.id === 12)?.label,
    "Earn a bonus sow: sow 1 seed from AI pit 6"
  )
  assert.equal(
    current.choices.find((c) => c.id === 9)?.label,
    "Sow 1 seed from AI pit 3"
  )
  for (const choice of current.choices) {
    assert.equal(resolvePitLabel(current.choices, choice.label), choice.id)
    assert.ok(!/BEST|PROVED|PRIORITY|DEFEAT/.test(choice.label))
  }
  assert.deepEqual(
    current.report?.preferredActions,
    current.choices
      .filter((c) => [7, 10, 12].includes(c.id))
      .map((c) => c.label)
  )
})
