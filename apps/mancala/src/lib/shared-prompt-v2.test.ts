import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import {
  analyzeMoves,
  buildMovePrompt,
  checkedPriorityChoices,
  SHARED_PROMPT_VERSION
} from "./shared-prompt.ts"
import { buildMovePrompt as baselinePrompt } from "./shared-prompt-v1.ts"
import type { Game } from "./mancala.ts"

const position = (board: number[]): Game => ({
  ...createGame(),
  turn: "ai",
  board
})
const first = () => position([0, 3, 3, 0, 9, 1, 6, 1, 2, 2, 9, 1, 8, 3])
const followup = () => position([0, 0, 4, 1, 10, 1, 6, 1, 0, 3, 10, 1, 8, 3])

test("v2 names the actual bonus-before-steal that v1 reported as zero", () => {
  const game = first()
  const old = buildMovePrompt(game, undefined, "shared-v1")
  assert.deepEqual(old, baselinePrompt(game))
  assert.equal(
    old.analysis.find((move) => move.pit === 12)?.maxHumanCaptureNext,
    0
  )
  const current = buildMovePrompt(game)
  assert.equal(current.version, SHARED_PROMPT_VERSION)
  const risky = current.choices.find((choice) => choice.id === 12)
  assert.ok(risky)
  assert.match(risky.outcome, /DANGER Human 3 > Human 5/)
  assert.match(risky.outcome, /steals 10 from AI pit 4 \+ 1 landing seed = 11/)
  assert.match(
    risky.outcome,
    /Separate worst-net line: Human 3 > Human 6; after THAT reply, AI 4/
  )
  assert.deepEqual(current.priorityPits, [10])
  assert.match(current.prompt, /CHECKED PRIORITY CHOICES: Pit 4/)
})

test("safe capture and exposed thirteen-seed stash are distinguished", () => {
  const input = buildMovePrompt(followup())
  assert.deepEqual(input.priorityPits, [7])
  const safe = input.choices.find((choice) => choice.id === 7)
  const trap = input.choices.find((choice) => choice.id === 9)
  assert.ok(safe && trap)
  assert.match(safe.outcome, /capture 11/)
  assert.match(safe.outcome, /STEAL-SAFE for the complete Human reply/)
  assert.match(trap.outcome, /steals 12 from AI pit 4 \+ 1 landing seed = 13/)
  assert.ok(!trap.outcome.includes("CHECKED PRIORITY"))
})

test("both versions keep every legal choice and priority is presentation-order invariant", () => {
  const game = followup(),
    original = structuredClone(game)
  const moves = legalMoves(game.board, "ai")
  for (const version of ["shared-v1", "shared-v2"] as const) {
    const forward = buildMovePrompt(game, moves, version)
    const reverse = buildMovePrompt(game, moves.toReversed(), version)
    assert.deepEqual(
      forward.choices.map((choice) => choice.id),
      moves
    )
    assert.deepEqual(
      reverse.choices.map((choice) => choice.id),
      moves.toReversed()
    )
    assert.deepEqual(forward.priorityPits, reverse.priorityPits)
  }
  assert.deepEqual(game, original)
})

test("partial turn scans cannot become compared scores or steal-safe groups", () => {
  const outcomes = analyzeMoves(first()).flatMap((move) =>
    move.tactical ? [move.tactical] : []
  )
  assert.ok(checkedPriorityChoices(outcomes).length)
  assert.deepEqual(
    checkedPriorityChoices(
      outcomes.map((move, i) =>
        i ? move : { ...move, complete: false, checkedScore: null }
      )
    ),
    []
  )
})

test("terminal wins include the final sweep and do not invent a safe Human reply", () => {
  const game = position([0, 0, 0, 2, 0, 0, 23, 1, 1, 0, 1, 1, 1, 18])
  const input = buildMovePrompt(game)
  const terminal = input.choices.find((choice) => choice.id === 8)
  assert.ok(terminal)
  assert.match(terminal.outcome, /FINISHED ai-won/)
  assert.match(terminal.outcome, /No Human reply: this AI turn ends the game/)
  assert.ok(!terminal.outcome.includes("STEAL-SAFE"))
  assert.ok(input.priorityPits?.includes(8))
})
