import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import { buildMovePrompt, SHARED_SYSTEM_PROMPT } from "./shared-prompt.ts"
test("thought-informed wording preserves outcomes while removing path and tie ambiguities", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [0, 3, 3, 0, 9, 1, 6, 1, 2, 2, 9, 1, 8, 3]
  }
  const old = buildMovePrompt(game, undefined, "shared-v4"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.analysis, old.analysis)
  assert.deepEqual(current.priorityPits, old.priorityPits)
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
  const dangerous = current.choices.find((c) => c.id === 12)
  assert.ok(dangerous)
  assert.match(dangerous.outcome, /Human sows pit 3, then pit 5/)
  assert.match(
    dangerous.outcome,
    /steals 10 from AI pit 4 plus 1 landing seed = 11/
  )
  assert.ok(!current.prompt.includes(" > "))
  assert.ok(!current.prompt.includes("Separate worst-net line"))
  assert.match(SHARED_SYSTEM_PROMPT, /Equal checked nets are TIED/)
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /tie-breakers, not proof of a higher checked net/
  )
  assert.ok(current.prompt.length < old.prompt.length)
})
