import assert from "node:assert/strict"
import test from "node:test"
import { behaviorGames, prepareBehaviorPositions } from "./behavior-positions.ts"
import { evaluateBehaviorPosition } from "./behavior-engine.ts"
import { applyMove, legalMoves } from "../src/lib/checkers.ts"
import { successorStateKey } from "./behavior-metrics.ts"

test("the behavior protocol freezes free-choice, tactical and forced strata from independent references", async () => {
  const games = behaviorGames()
  assert.equal(games.length, 12)
  assert.equal(games.filter(item => item.stratum === "free").length, 8)
  assert.equal(games.filter(item => item.stratum === "tactical").length, 3)
  assert.equal(games.filter(item => item.stratum === "forced").length, 1)
  assert.equal(new Set(games.map(item => item.id)).size, games.length)
  const positions = await prepareBehaviorPositions({ evaluate: async (game, options) => evaluateBehaviorPosition(game, options) }, new AbortController().signal)
  for (const position of positions) {
    const moves = legalMoves(position.game.board, "ai")
    assert.equal(position.game.turn, "ai")
    assert.ok(position.recommendedIds.every(id => moves.some(move => move.id === id)))
    if (position.stratum === "forced") assert.equal(moves.length, 1)
    if (position.stratum === "free") {
      const good = position.reference4.moves.filter(move => move.regret <= 25 && !position.unsafeMoveIds.includes(move.id))
      assert.ok(new Set(good.map(move => successorStateKey(applyMove(position.game, move.id)))).size >= 2, position.id)
    }
  }
})
