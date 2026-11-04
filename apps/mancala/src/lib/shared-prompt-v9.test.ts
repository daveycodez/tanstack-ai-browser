import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt-v9.ts"
test("concise table separates legal alternatives from one final preferred-action list", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 0, 4, 1, 10, 1, 6, 1, 0, 3, 10, 1, 8, 3]
  }
  const old = buildMovePrompt(game, undefined, "shared-v8"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.analysis, old.analysis)
  assert.deepEqual(current.report, old.report)
  assert.deepEqual(current.priorityPits, old.priorityPits)
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
  assert.equal(current.prompt.match(/PREFERRED AI ACTION LABELS:/g)?.length, 1)
  assert.ok(
    current.prompt.endsWith(
      'PREFERRED AI ACTION LABELS: ["Sow 1 seed from AI pit 1"]'
    )
  )
  assert.ok(current.prompt.length < old.prompt.length)
})
test("a no-capture loss remains explicit and cannot be confused with a recommended draw", () => {
  const input = buildMovePrompt({
    ...createGame(),
    turn: "ai" as const,
    board: [0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16]
  })
  const bad = input.choices.find((c) => c.id === 9)
  assert.ok(bad)
  assert.match(bad.outcome, /OTHER \| AI LOSS/)
  assert.match(
    bad.outcome,
    /opponent capture exposure 0; opponent winning reply yes/
  )
  assert.ok(input.choices.some((c) => c.outcome.includes("BEST | AI DRAW")))
})
