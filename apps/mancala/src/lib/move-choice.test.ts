import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import { pitChoiceLabel, resolvePitLabel } from "./move-choice.ts"
import { buildMovePrompt } from "./shared-prompt.ts"
test("literal AI actions resolve exactly and cannot be confused with Human replies", () => {
  const game = { ...createGame(), turn: "ai" as const }
  const moves = legalMoves(game.board, "ai")
  for (const version of [
    "shared-v1",
    "shared-v2",
    "shared-v3",
    "shared-v4",
    "shared-v5",
    "shared-v6",
    "shared-v7",
    "shared-v8",
    "shared-v9",
    "shared-v10",
    "shared-v11",
    "shared-v12"
  ] as const) {
    const input = buildMovePrompt(game, moves, version)
    for (const choice of input.choices)
      assert.equal(resolvePitLabel(input.choices, choice.label), choice.id)
    assert.throws(
      () => resolvePitLabel(input.choices, "Human 3 > Human 5"),
      /noncanonical/
    )
  }
  const input = buildMovePrompt(game, moves, "shared-v3")
  assert.throws(() => resolvePitLabel(input.choices, "3"), /noncanonical/)
  assert.throws(
    () =>
      resolvePitLabel(
        [...input.choices, input.choices[0]],
        input.choices[0].label
      ),
    /unique/
  )
  assert.equal(pitChoiceLabel(7, 1), "Sow 1 seed from AI pit 1")
})
test("v3 preserves v2 outcomes but repeats exact priority action labels without a numeric enum footer", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 3, 3, 0, 9, 1, 6, 1, 2, 2, 9, 1, 8, 3]
  }
  const v2 = buildMovePrompt(game, undefined, "shared-v2"),
    v3 = buildMovePrompt(game, undefined, "shared-v3")
  assert.deepEqual(v3.analysis, v2.analysis)
  assert.deepEqual(v3.priorityPits, [10])
  assert.equal(
    v3.choices.find((c) => c.id === 10)?.label,
    "Sow 9 seeds from AI pit 4"
  )
  assert.match(
    v3.prompt,
    /CHECKED PRIORITY ACTIONS: "Sow 9 seeds from AI pit 4"/
  )
  assert.ok(!v3.prompt.includes('quoted legal label: "1"'))
  assert.deepEqual(
    v3.choices.map((c) => c.id),
    v2.choices.map((c) => c.id)
  )
})
