import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import { buildMovePrompt, SHARED_SYSTEM_PROMPT } from "./shared-prompt-v10.ts"
test("proved defeat is explicit even when its margin is a bounded preview and capture exposure is zero", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16]
  }
  const old = buildMovePrompt(game, undefined, "shared-v9"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.analysis, old.analysis)
  assert.deepEqual(current.report, old.report)
  assert.deepEqual(current.priorityPits, [7, 10, 12])
  const bad = current.choices.find((c) => c.id === 9)
  assert.ok(bad)
  assert.match(bad.outcome, /PROVED DEFEAT FOR YOU/)
  assert.match(bad.outcome, /AI-defeat reply exists yes/)
  assert.ok(!bad.outcome.includes("opponent winning reply yes"))
  assert.ok(
    current.choices.some((c) => c.outcome.includes("PROVED DRAW FOR YOU"))
  )
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
})
test("tie instruction distinguishes preferred order from legal-schema order", () => {
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /FIRST label from PREFERRED AI ACTION LABELS/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /never the first legal\/schema\/table label/
  )
})
