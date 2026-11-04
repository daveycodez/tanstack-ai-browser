import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt-v4.ts"
test("v4 finishes a win now before an equally winning bonus continuation", () => {
  for (const [board, expected] of [
    [[0, 0, 0, 2, 0, 0, 23, 1, 1, 0, 1, 1, 1, 18], [8]],
    [
      [0, 0, 2, 0, 0, 0, 23, 3, 0, 1, 0, 0, 1, 18],
      [7, 9]
    ]
  ] as const) {
    const game = { ...createGame(), turn: "ai" as const, board: [...board] }
    const old = buildMovePrompt(game, undefined, "shared-v3"),
      current = buildMovePrompt(game)
    assert.ok(old.priorityPits?.includes(12))
    assert.deepEqual(current.priorityPits, [...expected])
    assert.deepEqual(current.analysis, old.analysis)
    assert.deepEqual(
      current.choices.map((c) => c.id),
      old.choices.map((c) => c.id)
    )
    assert.ok(
      !current.choices
        .find((c) => c.id === 12)
        ?.outcome.includes("CHECKED PRIORITY")
    )
    assert.match(current.prompt, /These WIN NOW/)
  }
})
test("v4 preserves complete-turn defense when no immediate finish exists", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 3, 3, 0, 9, 1, 6, 1, 2, 2, 9, 1, 8, 3]
  }
  const old = buildMovePrompt(game, undefined, "shared-v3"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.priorityPits, [10])
  assert.deepEqual(current.analysis, old.analysis)
})
