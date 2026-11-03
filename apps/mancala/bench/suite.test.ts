import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { CASES, gameForCase } from "./cases.ts"
import { auditSuite } from "./audit.ts"
import { completeTurns, expectedForCase, objectiveValues } from "./reference.ts"
import { applyMove, createGame, sow } from "../src/lib/mancala.ts"

function getCase(id: string) {
  const fixture = CASES.find((item) => item.id === id)
  assert.ok(fixture, `Missing fixture: ${id}`)
  return fixture
}

test("every frozen objective matches an exhaustive complete-turn audit", () => {
  const audit = auditSuite()
  assert.equal(audit.cases, 21)
  assert.equal(audit.scored, 18)
  assert.equal(audit.holdout, 3)
  assert.equal(new Set(CASES.map((item) => item.category)).size, 6)
})
test("bonus-turn continuations contribute to the grade", () => {
  const fixture = getCase("chain-into-capture")
  const first = sow(fixture.board, "ai", 11)
  assert.equal(first.extraTurn, true)
  assert.equal(first.board[13] - fixture.board[13], 1)
  assert.equal(
    objectiveValues(fixture).find((item) => item.pit === 11)?.value,
    15
  )
  assert.equal(
    Math.max(
      ...completeTurns(first.board, "ai").map(
        (end) => end.board[13] - fixture.board[13]
      )
    ),
    15
  )
})
test("equal immediate captures are distinguished by the full reply", () => {
  const fixture = getCase("equal-captures")
  assert.equal(sow(fixture.board, "ai", 8).captured, 4)
  assert.equal(sow(fixture.board, "ai", 9).captured, 4)
  assert.equal(sow(fixture.board, "ai", 10).captured, 4)
  assert.deepEqual(expectedForCase(fixture), [9])
})
test("all tied terminal wins are accepted", () => {
  const fixture = getCase("tied-wins")
  assert.deepEqual(expectedForCase(fixture), [7, 9])
  assert.ok(fixture.expectedPits)
  for (const pit of fixture.expectedPits)
    assert.equal(sow(fixture.board, "ai", pit).status, "ai-won")
})
test("a draw is scored above the bounded losing alternatives", () => {
  const fixture = getCase("save-the-draw")
  assert.equal(sow(fixture.board, "ai", 7).status, "draw")
  assert.deepEqual(expectedForCase(fixture), [7, 10, 12])
})
test("the benchmark positions never share mutable board or history state", () => {
  const first = gameForCase(getCase("opening"))
  const second = gameForCase(getCase("opening"))
  first.board[0] = 0
  assert.equal(second.board[0], 4)
  assert.equal(getCase("opening").board[0], 4)
  assert.notEqual(first.history, second.history)
  assert.equal(first.turn, "ai")
})

test("bonus-steal regressions are reachable from legal opening histories", () => {
  const opening = [5, 7, 1, 8, 2, 9, 5, 11, 0, 7, 5, 3]
  let game = createGame()
  for (const pit of opening) game = applyMove(game, pit)
  assert.equal(game.turn, "ai")
  assert.deepEqual(game.board, getCase("bonus-steal-defense").board)
  for (const pit of [8, 1]) game = applyMove(game, pit)
  assert.equal(game.turn, "ai")
  assert.deepEqual(game.board, getCase("safe-capture-over-exposure").board)
  assert.deepEqual(expectedForCase(getCase("bonus-steal-defense")), [10])
  assert.deepEqual(expectedForCase(getCase("safe-capture-over-exposure")), [7])
})

test("the formerly short-horizon miss is judged by its proven terminal margin", () => {
  const fixture = getCase("capture-or-bonus")
  assert.equal(fixture.objective, "best-final-margin")
  assert.deepEqual(objectiveValues(fixture), [
    { pit: 7, value: 4 },
    { pit: 8, value: 8 },
    { pit: 10, value: 2 },
    { pit: 11, value: 12 },
    { pit: 12, value: 2 }
  ])
  assert.deepEqual(expectedForCase(fixture), [11])
})

test("the Sol match regression replays from the actual opening and grades every terminal alternative", () => {
  const recorded = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/sol-game-review-2026-11-03/original-game.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as {
    moves: {
      move: number
      player: string
      pit: number
      seeds: number
      captured: number
      extraTurn: boolean
    }[]
  }
  let game = createGame()
  const fixture = getCase("sol-match-preserve-margin")
  for (const move of recorded.moves) {
    if (move.move === 26) {
      assert.equal(game.turn, "ai")
      assert.deepEqual(game.board, fixture.board)
    }
    const isAI = move.player.startsWith("LFM3")
    assert.equal(game.turn, isAI ? "ai" : "human")
    const pit = isAI ? move.pit + 6 : move.pit - 1
    assert.equal(game.board[pit], move.seeds)
    const next = applyMove(game, pit)
    const action = next.history.at(-1)
    assert.equal(action?.captured, move.captured)
    assert.equal(action?.extraTurn, move.extraTurn)
    game = next
  }
  assert.equal(game.status, "human-won")
  assert.equal(game.board[6], 28)
  assert.equal(game.board[13], 20)
  assert.deepEqual(objectiveValues(fixture), [
    { pit: 7, value: -14 },
    { pit: 8, value: -8 },
    { pit: 11, value: -8 },
    { pit: 12, value: -6 }
  ])
  assert.deepEqual(expectedForCase(fixture), [12])
})

test("the new draw-to-loss regression accepts only the independently proved drawing move", () => {
  const fixture = getCase("sol-match-save-forced-draw")
  assert.deepEqual(objectiveValues(fixture), [
    { pit: 7, value: 0 },
    { pit: 8, value: -2 },
    { pit: 10, value: -2 }
  ])
  assert.deepEqual(expectedForCase(fixture), [7])
})
