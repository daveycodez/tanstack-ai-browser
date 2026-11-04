import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import { buildMovePrompt, SHARED_SYSTEM_PROMPT } from "./shared-prompt-v7.ts"
const position = () => ({
  ...createGame(),
  turn: "ai" as const,
  board: [1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13]
})
test("terminal regret makes a narrower win explicitly inferior without changing computed facts", () => {
  const game = position(),
    before = structuredClone(game)
  const old = buildMovePrompt(game, undefined, "shared-v6"),
    current = buildMovePrompt(game)
  assert.deepEqual(current.endgame, old.endgame)
  assert.deepEqual(current.analysis, old.analysis)
  assert.deepEqual(current.priorityPits, [11])
  assert.deepEqual(
    current.choices.map((c) => [c.id, c.label]),
    old.choices.map((c) => [c.id, c.label])
  )
  const best = current.choices.find((c) => c.id === 11),
    weak = current.choices.find((c) => c.id === 12)
  assert.ok(best && weak)
  assert.match(best.outcome, /BEST COMPARED FINISH; zero final-score loss/)
  assert.match(
    weak.outcome,
    /gives up 5 final AI seeds and 10 points of final margin/
  )
  assert.ok(!weak.outcome.includes("optimal AI turn"))
  assert.match(weak.outcome, /Conditional on choosing THIS action/)
  assert.match(
    current.prompt,
    /Reject an INFERIOR COMPARED FINISH even if it still wins/
  )
  assert.deepEqual(game, before)
})
test("reversing choices preserves factual comparison and every legal action", () => {
  const game = position(),
    moves = legalMoves(game.board, "ai")
  const forward = buildMovePrompt(game, moves),
    reversed = buildMovePrompt(game, moves.toReversed())
  assert.deepEqual(forward.priorityPits, reversed.priorityPits)
  assert.deepEqual(
    reversed.choices.map((c) => c.id),
    moves.toReversed()
  )
  assert.match(
    reversed.prompt,
    /"Sow 5 seeds from AI pit 6" => AI 25, Human 23; final margin \+2. INFERIOR/
  )
  assert.match(
    reversed.prompt,
    /"Sow 2 seeds from AI pit 5" => AI 30, Human 18; final margin \+12. BEST/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /A positive final margin can still be INFERIOR/
  )
})
