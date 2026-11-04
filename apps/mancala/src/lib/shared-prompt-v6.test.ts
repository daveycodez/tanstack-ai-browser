import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, createGame } from "./mancala.ts"
import { buildMovePrompt } from "./shared-prompt-v6.ts"

test("a narrower forced win no longer hides behind a four-turn tie", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13]
  }
  const old = buildMovePrompt(game, undefined, "shared-v5"),
    current = buildMovePrompt(game)
  assert.deepEqual(old.priorityPits, [11, 12])
  assert.equal(current.endgame?.complete, true)
  assert.deepEqual(current.priorityPits, [11])
  assert.deepEqual(
    current.choices.map((choice) => [choice.id, choice.label]),
    old.choices.map((choice) => [choice.id, choice.label])
  )
  const best = current.choices.find((choice) => choice.id === 11),
    weak = current.choices.find((choice) => choice.id === 12)
  assert.ok(best && weak)
  assert.match(
    best.outcome,
    /EXACT FINAL MARGIN \+12; final stores AI 30, Human 18/
  )
  assert.match(best.outcome, /optimal AI turn starts with pit 5, then pit 2/)
  assert.match(
    weak.outcome,
    /EXACT FINAL MARGIN \+2; final stores AI 25, Human 23/
  )
  assert.ok(!weak.outcome.includes("CHECKED PRIORITY"))
  assert.ok(!best.outcome.includes("AI sows pit 5, then pit 1"))
})
test("early positions retain bounded analysis without pretending to solve the game", () => {
  const game = { ...createGame(), turn: "ai" as const }
  const input = buildMovePrompt(game)
  assert.equal(input.endgame?.complete, false)
  assert.ok(!input.prompt.includes("EXACT FINAL MARGIN"))
})

test("the verified first move and its actual bonus turn use the same winning plan", () => {
  const game = {
    ...createGame(),
    turn: "ai" as const,
    board: [1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13]
  }
  const first = buildMovePrompt(game)
  const next = buildMovePrompt(applyMove(game, 11))
  assert.deepEqual(
    first.endgame?.moves.find((move) => move.pit === 11)?.bestAiTurn,
    [11, 8]
  )
  assert.deepEqual(next.priorityPits, [8])
  assert.match(
    next.choices.find((choice) => choice.id === 8)?.outcome ?? "",
    /final stores AI 30, Human 18/
  )
})
