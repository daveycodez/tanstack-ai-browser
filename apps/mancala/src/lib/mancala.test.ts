import assert from "node:assert/strict"
import test from "node:test"
import {
  applyMove,
  chooseEngineMove,
  createGame,
  legalMoves,
  pitName,
  sow
} from "./mancala.ts"
import type { Board, Game } from "./mancala.ts"

const total = (board: Board) => board.reduce((sum, seeds) => sum + seeds, 0)
const fixture = (board: Board, turn: Game["turn"] = "human"): Game => ({
  ...createGame(),
  board,
  turn
})

test("new game has twelve four-seed pits, two empty stores, and a unique session", () => {
  const game = createGame()
  assert.equal(total(game.board), 48)
  assert.equal(game.board[6], 0)
  assert.equal(game.board[13], 0)
  assert.deepEqual(legalMoves(game.board, "human"), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(legalMoves(game.board, "ai"), [7, 8, 9, 10, 11, 12])
  assert.notEqual(game.sessionId, createGame().sessionId)
})

test("opening pit three finishes in your store and grants another turn", () => {
  const game = createGame()
  const frozen = JSON.stringify(game)
  const next = applyMove(game, 2)
  assert.deepEqual(next.history[0].drops, [3, 4, 5, 6])
  assert.equal(next.board[2], 0)
  assert.equal(next.board[6], 1)
  assert.equal(next.turn, "human")
  assert.equal(next.history[0].extraTurn, true)
  assert.equal(JSON.stringify(game), frozen)
  assert.equal(total(next.board), 48)
})

test("both players sow past the opponent's store without depositing in it", () => {
  const human = [1, 0, 0, 0, 0, 15, 0, 1, 1, 1, 1, 1, 1, 25]
  const a = sow(human, "human", 5)
  assert.equal(a.drops.length, 15)
  assert.ok(!a.drops.includes(13))
  assert.equal(a.board[13], 25)
  const ai = [1, 1, 1, 1, 1, 1, 25, 1, 0, 0, 0, 0, 15, 0]
  const b = sow(ai, "ai", 12)
  assert.ok(!b.drops.includes(6))
  assert.equal(b.board[6], 25)
  assert.equal(total(a.board), total(human))
  assert.equal(total(b.board), total(ai))
})

test("landing in your empty pit captures the opposite seeds and landing seed", () => {
  const board = [1, 0, 1, 1, 1, 1, 15, 1, 1, 1, 1, 5, 1, 18]
  const next = sow(board, "human", 0)
  assert.equal(next.captured, 6)
  assert.equal(next.board[1], 0)
  assert.equal(next.board[11], 0)
  assert.equal(next.board[6], 21)
  assert.equal(next.status, "playing")
  assert.equal(total(next.board), total(board))
})

test("AI capture uses the mirrored opposite pit", () => {
  const board = [1, 1, 1, 1, 5, 1, 18, 1, 0, 1, 1, 1, 1, 15]
  const next = sow(board, "ai", 7)
  assert.equal(next.captured, 6)
  assert.equal(next.board[8], 0)
  assert.equal(next.board[4], 0)
  assert.equal(next.board[13], 21)
})

test("empty opposite pit leaves the landing seed in place", () => {
  const board = [1, 0, 1, 1, 1, 1, 20, 1, 1, 1, 1, 0, 1, 19]
  const next = sow(board, "human", 0)
  assert.equal(next.captured, 0)
  assert.equal(next.board[1], 1)
})

test("landing on the opponent's empty pit never captures", () => {
  const board = [1, 1, 1, 1, 1, 2, 19, 0, 1, 1, 1, 1, 1, 18]
  const next = sow(board, "human", 5)
  assert.equal(next.lastPit, 7)
  assert.equal(next.captured, 0)
  assert.equal(next.board[7], 1)
})

test("empty side ends the game and sweeps both rows, even after a store landing", () => {
  const board = [0, 0, 0, 0, 0, 1, 23, 4, 4, 4, 4, 4, 4, 0]
  const result = sow(board, "human", 5)
  assert.equal(result.status, "draw")
  assert.equal(result.extraTurn, false)
  assert.equal(result.board[6], 24)
  assert.equal(result.board[13], 24)
  assert.equal(result.swept.ai, 24)
  assert.ok(
    result.board.every(
      (seeds, index) => index === 6 || index === 13 || seeds === 0
    )
  )
  assert.equal(total(result.board), 48)
})

test("a final capture can empty the opposite row and determine the winner", () => {
  const game = fixture([1, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 5, 0, 22])
  const next = applyMove(game, 0)
  assert.equal(next.status, "human-won")
  assert.equal(next.board[6], 26)
  assert.equal(next.board[13], 22)
  assert.equal(next.history[0].captured, 6)
  assert.equal(next.history[0].finished, true)
  assert.throws(() => applyMove(next, 1), /finished/)
})

test("invalid moves and malformed boards are rejected without mutation", () => {
  const game = createGame()
  for (const pit of [-1, 6, 7, 13, 14, 1.5, NaN])
    assert.throws(() => applyMove(game, pit))
  const next = applyMove(game, 2)
  assert.throws(() => applyMove(next, 2))
  assert.throws(() => sow([], "human", 0))
  assert.throws(() => sow([NaN, ...game.board.slice(1)], "human", 0))
  assert.throws(() => sow([-1, ...game.board.slice(1)], "human", 0))
  assert.equal(total(game.board), 48)
  assert.throws(() => pitName(6))
  assert.equal(pitName(0), "1")
  assert.equal(pitName(12), "6")
})

test("complete deterministic games preserve all seeds and end with empty rows", () => {
  for (let seed = 1; seed <= 30; seed++) {
    let state = seed
    let game = createGame()
    let moves = 0
    while (game.status === "playing" && moves < 1000) {
      state = (state * 1664525 + 1013904223) >>> 0
      const legal = legalMoves(game.board, game.turn)
      assert.ok(legal.length > 0)
      const next = applyMove(game, legal[state % legal.length])
      assert.equal(total(next.board), 48)
      assert.ok(
        next.board.every((seeds) => Number.isSafeInteger(seeds) && seeds >= 0)
      )
      assert.deepEqual(next.history.at(-1)?.boardBefore, game.board)
      game = next
      moves++
    }
    assert.notEqual(game.status, "playing")
    assert.equal(game.board[6] + game.board[13], 48)
  }
})

test("reference player chooses a forced winning capture and returns legal moves", () => {
  const game = fixture([1, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 5, 0, 22])
  assert.equal(chooseEngineMove(game), 0)
  const opening = createGame()
  assert.ok(
    legalMoves(opening.board, opening.turn).includes(
      chooseEngineMove(opening, 3)
    )
  )
  assert.throws(() => chooseEngineMove(applyMove(game, 0)), /finished/)
})
