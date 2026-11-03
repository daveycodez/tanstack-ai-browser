import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, createGame, legalMoves, sow } from "./mancala.ts"
import {
  ANALYSIS_PLIES,
  analyzeMoves,
  buildMovePrompt,
  SHARED_PROMPT_VERSION,
  SHARED_SYSTEM_PROMPT
} from "./shared-prompt.ts"
import type { Board, Game, Side } from "./mancala.ts"

function position(board: number[]): Game {
  assert.equal(
    board.reduce((sum, count) => sum + count, 0),
    48
  )
  return { ...createGame(), board, turn: "ai" }
}

test("every legal pit remains available with independently checked context", () => {
  const game = { ...createGame(), turn: "ai" as const }
  const before = structuredClone(game)
  const input = buildMovePrompt(game)
  assert.equal(input.version, SHARED_PROMPT_VERSION)
  assert.deepEqual(
    input.choices.map((choice) => choice.id),
    legalMoves(game.board, "ai")
  )
  assert.deepEqual(
    input.choices.map((choice) => choice.label),
    ["1", "2", "3", "4", "5", "6"]
  )
  assert.deepEqual(game, before)
  assert.equal(input.analysis.length, 6)
  assert.ok(
    input.analysis.every(
      (choice) => choice.principalLine.length <= ANALYSIS_PLIES
    )
  )
  assert.match(SHARED_SYSTEM_PROMPT, /six sow actions/)
  assert.match(SHARED_SYSTEM_PROMPT, /bounded previews do not prove/)
  assert.match(SHARED_SYSTEM_PROMPT, /Never combine outcomes/)
})

test("captures include the landing seed and a secured majority is marked", () => {
  const game = position([1, 1, 1, 1, 7, 1, 15, 1, 0, 2, 0, 0, 0, 18])
  const input = buildMovePrompt(game)
  const capture = input.analysis.find((choice) => choice.pit === 7)
  assert.ok(capture)
  assert.equal(capture.captured, 8)
  assert.equal(capture.storeGain, 8)
  assert.ok(capture.checkedScore >= 1000)
  const choice = input.choices.find((choice) => choice.id === 7)
  assert.ok(choice)
  assert.match(choice.outcome, /capture 8/)
  assert.match(choice.outcome, /guaranteed outcome/)
})

test("bonus actions continue with the same player within the bounded preview", () => {
  const game = position([2, 2, 2, 2, 2, 2, 15, 1, 1, 1, 1, 2, 1, 14])
  const bonus = analyzeMoves(game, [12])[0]
  assert.equal(bonus.extraTurn, true)
  assert.equal(bonus.principalLine[0].pit, 12)
  assert.equal(bonus.principalLine[1].side, "ai")
  assert.ok(bonus.principalLine.length <= ANALYSIS_PLIES)
})

test("a final-store landing is scored after the human sweep and earns no bonus", () => {
  const game = position([1, 1, 1, 1, 1, 1, 20, 0, 0, 0, 0, 0, 1, 21])
  const input = buildMovePrompt(game)
  assert.equal(input.analysis[0].immediateStatus, "human-won")
  assert.equal(input.analysis[0].extraTurn, false)
  assert.equal(input.analysis[0].checkedScore, -1004)
  assert.match(input.choices[0].outcome, /swept final score AI 22, human 26/)
})

test("search scores are invariant to legal-card order", () => {
  const game = { ...createGame(), turn: "ai" as const }
  const moves = legalMoves(game.board, "ai")
  const normal = analyzeMoves(game, moves)
  const reversed = analyzeMoves(game, [...moves].reverse())
  for (const move of normal)
    assert.equal(
      reversed.find((candidate) => candidate.pit === move.pit)?.checkedScore,
      move.checkedScore
    )
  assert.deepEqual(
    buildMovePrompt(game, [...moves].reverse()).choices.map(
      (choice) => choice.id
    ),
    [...moves].reverse()
  )
  assert.throws(() => buildMovePrompt(game, [7, 7]), /distinct legal/)
  assert.throws(() => buildMovePrompt(game, [6]), /distinct legal/)
})

test("guarantee labels agree with an independent AND/OR proof across reachable games", () => {
  // This proof ignores all store-margin scores. A claim succeeds only when the
  // named player can secure a majority against every enemy continuation.
  function provesWin(
    board: Board,
    turn: Side,
    status: Game["status"],
    remaining: number,
    winner: Side
  ): boolean {
    const own = winner === "ai" ? 13 : 6
    if (board[own] > 24 || status === `${winner}-won`) return true
    if (status !== "playing" || remaining === 0) return false
    const branches = legalMoves(board, turn).map((pit) => {
      const next = sow(board, turn, pit)
      return provesWin(
        next.board,
        next.turn,
        next.status,
        remaining - 1,
        winner
      )
    })
    return turn === winner
      ? branches.some(Boolean)
      : branches.length > 0 && branches.every(Boolean)
  }
  let state = 164529
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  let checked = 0,
    guaranteed = 0
  for (let round = 0; round < 3; round++) {
    let game = createGame()
    for (let ply = 0; ply < 140 && game.status === "playing"; ply++) {
      const moves = legalMoves(game.board, game.turn)
      game = applyMove(game, moves[random() % moves.length])
      if (game.turn !== "ai" || game.status !== "playing" || ply % 5 !== 0)
        continue
      const movesToCheck = legalMoves(game.board, "ai")
      const normal = analyzeMoves(game, movesToCheck)
      const reversed = analyzeMoves(game, [...movesToCheck].reverse())
      for (const move of normal) {
        const next = sow(game.board, "ai", move.pit)
        assert.equal(
          move.checkedScore >= 1000,
          provesWin(
            next.board,
            next.turn,
            next.status,
            ANALYSIS_PLIES - 1,
            "ai"
          )
        )
        assert.equal(
          move.checkedScore <= -1000,
          provesWin(
            next.board,
            next.turn,
            next.status,
            ANALYSIS_PLIES - 1,
            "human"
          )
        )
        assert.equal(
          move.checkedScore,
          reversed.find((other) => other.pit === move.pit)?.checkedScore
        )
        guaranteed += Number(Math.abs(move.checkedScore) >= 1000)
        checked++
      }
    }
  }
  assert.ok(
    checked > 40,
    "check varied reachable boards, not only contrived wins"
  )
  assert.ok(guaranteed > 0, "exercise actual guaranteed outcomes")
})
