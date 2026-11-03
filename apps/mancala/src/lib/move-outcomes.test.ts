import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, createGame, legalMoves, sow } from "./mancala.ts"
import type { Board, Game, GameStatus, Side } from "./mancala.ts"
import { analyzeTacticalMoves } from "./move-outcomes.ts"
import type { TacticalMoveOutcome } from "./move-outcomes.ts"

const hiddenSteal = [0, 3, 3, 0, 9, 1, 6, 1, 2, 2, 9, 1, 8, 3]
const avoidSteal = [0, 0, 4, 1, 10, 1, 6, 1, 0, 3, 10, 1, 8, 3]
function position(board: number[]): Game {
  assert.equal(
    board.reduce((sum, seeds) => sum + seeds, 0),
    48
  )
  return { ...createGame(), board, turn: "ai" }
}
function choice(outcomes: TacticalMoveOutcome[], pit: number) {
  const found = outcomes.find((outcome) => outcome.pit === pit)
  assert.ok(found)
  return found
}

function verifyWitness(game: Game, outcome: TacticalMoveOutcome) {
  let board = game.board
  for (const pit of outcome.bestAiTurn) board = sow(board, "ai", pit).board
  const witness = outcome.humanSteal
  assert.ok(witness)
  let event = 0
  for (let i = 0; i < witness.path.length; i++) {
    const pit = witness.path[i]
    const next = sow(board, "human", pit)
    if (next.captured) {
      assert.deepEqual(witness.captures[event++], {
        movePit: pit,
        landingPit: next.lastPit,
        targetPit: 12 - next.lastPit,
        stolenSeeds: next.captured - 1,
        captured: next.captured
      })
    }
    assert.equal(next.extraTurn, i < witness.path.length - 1)
    board = next.board
  }
  assert.equal(
    witness.totalCaptured,
    witness.captures.reduce((sum, capture) => sum + capture.captured, 0)
  )
  assert.equal(
    witness.totalStolen + witness.captures.length,
    witness.totalCaptured
  )
}

test("full Human turn finds a bonus-then-steal hidden from every immediate sow", () => {
  const game = position(hiddenSteal)
  const first = sow(game.board, "ai", 12)
  const direct = legalMoves(first.board, "human").map((pit) =>
    sow(first.board, "human", pit)
  )
  assert.equal(Math.max(...direct.map((reply) => reply.captured)), 0)
  const outcome = choice(analyzeTacticalMoves(game), 12)
  assert.equal(outcome.safetyChecked, true)
  assert.equal(outcome.maxHumanCapture, 11)
  assert.equal(outcome.maxHumanStolenSeeds, 10)
  assert.deepEqual(outcome.humanSteal?.path, [2, 4])
  assert.deepEqual(outcome.humanSteal?.captures, [
    { movePit: 4, landingPit: 2, targetPit: 10, stolenSeeds: 10, captured: 11 }
  ])
  verifyWitness(game, outcome)
})

test("the safer winning capture outranks moves exposing twelve- and thirteen-seed steals", () => {
  const game = position(avoidSteal)
  const outcomes = analyzeTacticalMoves(game)
  const capture = choice(outcomes, 7),
    risky = choice(outcomes, 9),
    otherRisk = choice(outcomes, 11)
  assert.equal(capture.captured, 11)
  assert.equal(capture.aiTurnCapture, 11)
  assert.equal(capture.maxHumanCapture, 0)
  assert.equal(risky.maxHumanCapture, 13)
  assert.equal(otherRisk.maxHumanCapture, 12)
  assert.ok(capture.checkedScore !== null && risky.checkedScore !== null)
  assert.ok(capture.checkedScore > risky.checkedScore)
  assert.ok(capture.checkedScore > (otherRisk.checkedScore ?? Infinity))
  verifyWitness(game, risky)
  verifyWitness(game, otherRisk)
})

test("a long own bonus chain is finished before describing the Human handoff", () => {
  const game = position([4, 4, 4, 4, 4, 4, 3, 6, 5, 4, 3, 2, 1, 0])
  const outcome = choice(analyzeTacticalMoves(game), 12)
  assert.equal(outcome.extraTurn, true)
  assert.equal(outcome.complete, true)
  assert.ok(outcome.bestAiTurn.length > 6)
  let board = game.board
  for (let i = 0; i < outcome.bestAiTurn.length; i++) {
    const end = sow(board, "ai", outcome.bestAiTurn[i])
    assert.equal(end.extraTurn, i < outcome.bestAiTurn.length - 1)
    board = end.board
  }
  assert.equal(board[13] - game.board[13], outcome.aiTurnStoreGain)
  assert.equal(outcome.safetyChecked, true)
  assert.equal(outcome.principalLine[outcome.bestAiTurn.length].side, "human")
})

test("steal warnings are conditional on the selected own bonus plan, not a bad alternate plan", () => {
  const game = { ...createGame(), turn: "ai" as const }
  const outcome = choice(analyzeTacticalMoves(game), 9)
  assert.equal(outcome.extraTurn, true)
  assert.ok(outcome.bestAiTurn.length > 1)
  if (outcome.humanSteal) verifyWitness(game, outcome)
  else assert.equal(outcome.maxHumanCapture, 0)
})

test("terminal sweeps include all seeds and cannot manufacture another turn", () => {
  const game = position([1, 1, 1, 1, 1, 1, 20, 0, 0, 0, 0, 0, 1, 21])
  const outcome = analyzeTacticalMoves(game)[0]
  assert.equal(outcome.immediateStatus, "human-won")
  assert.equal(outcome.extraTurn, false)
  assert.equal(outcome.checkedMargin, -4)
  assert.equal(outcome.checkedScore, -1004)
  assert.equal(outcome.guaranteedOutcome, "human-win")
  assert.deepEqual(outcome.bestAiTurn, [12])
  assert.deepEqual(outcome.worstHumanReply, [])
})

test("every root is lowered to the same exact completed-turn horizon after a budget limit", () => {
  const game = { ...createGame(), turn: "ai" as const }
  const outcomes = analyzeTacticalMoves(game, undefined, {
    maxNodesPerMove: 100
  })
  assert.ok(
    outcomes.every(
      (outcome) => outcome.complete && outcome.completeTurnsChecked === 2
    )
  )
  const exactTwo = analyzeTacticalMoves(game, undefined, { turns: 2 })
  assert.deepEqual(
    outcomes.map((outcome) => outcome.checkedScore),
    exactTwo.map((outcome) => outcome.checkedScore)
  )
})

test("unfinished search or safety checks never turn partial values into safe or winning facts", () => {
  const game = position(hiddenSteal)
  const limited = analyzeTacticalMoves(game, undefined, { maxNodesPerMove: 1 })
  assert.ok(
    limited.every(
      (outcome) =>
        !outcome.complete &&
        outcome.checkedScore === null &&
        outcome.checkedMargin === null &&
        outcome.completeTurnsChecked === 0 &&
        outcome.guaranteedOutcome === undefined
    )
  )
  const safetyLimited = choice(
    analyzeTacticalMoves(game, [12], { maxSafetyNodes: 1 }),
    12
  )
  assert.equal(safetyLimited.complete, true)
  assert.equal(safetyLimited.safetyChecked, false)
  assert.equal(safetyLimited.maxHumanCapture, null)
  assert.equal(safetyLimited.maxHumanStolenSeeds, null)
  assert.equal(safetyLimited.humanCanWinNext, null)
})

test("all legal choices remain independent of card order and the input is immutable", () => {
  const game = position(hiddenSteal)
  const before = structuredClone(game)
  const moves = legalMoves(game.board, "ai")
  const normal = analyzeTacticalMoves(game, moves)
  const reversed = analyzeTacticalMoves(game, moves.slice().reverse()).reverse()
  assert.deepEqual(reversed, normal)
  assert.deepEqual(game, before)
  assert.throws(() => analyzeTacticalMoves(game, [7, 7]), /distinct legal/)
  assert.throws(() => analyzeTacticalMoves(game, [6]), /distinct legal/)
  assert.throws(
    () => analyzeTacticalMoves(game, undefined, { turns: 0 }),
    /two to four/
  )
})

/** Independent unpruned tree: no production tables, alpha-beta windows, paths or priority groups. */
function exhaustive(
  board: Board,
  side: Side,
  status: GameStatus,
  turns: number
): number {
  if (status !== "playing" || !turns) {
    const result =
      status === "ai-won" || board[13] > 24
        ? 1
        : status === "human-won" || board[6] > 24
          ? -1
          : 0
    return result * 1000 + board[13] - board[6]
  }
  const values = legalMoves(board, side).map((pit) => {
    const next = sow(board, side, pit)
    return exhaustive(
      next.board,
      next.turn,
      next.status,
      turns - Number(next.turn !== side)
    )
  })
  return side === "ai" ? Math.max(...values) : Math.min(...values)
}

test("alpha-beta scores agree with exhaustive completed-turn minimax on varied reachable boards", () => {
  let seed = 25317,
    checked = 0,
    positions = 0
  for (let round = 0; round < 5 && positions < 24; round++) {
    let game = createGame()
    for (
      let ply = 0;
      ply < 140 && game.status === "playing" && positions < 24;
      ply++
    ) {
      const moves = legalMoves(game.board, game.turn)
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      game = applyMove(game, moves[seed % moves.length])
      if (game.status !== "playing" || game.turn !== "ai" || ply % 3) continue
      const legal = legalMoves(game.board, "ai")
      const results = analyzeTacticalMoves(game, legal, { turns: 2 })
      const reversed = analyzeTacticalMoves(game, legal.slice().reverse(), {
        turns: 2
      })
      for (const outcome of results) {
        const first = sow(game.board, "ai", outcome.pit)
        assert.equal(outcome.complete, true)
        assert.equal(
          outcome.checkedScore,
          exhaustive(
            first.board,
            first.turn,
            first.status,
            2 - Number(first.turn !== "ai")
          )
        )
        assert.equal(
          outcome.checkedScore,
          choice(reversed, outcome.pit).checkedScore
        )
        checked++
      }
      positions++
    }
  }
  assert.equal(positions, 24)
  assert.ok(checked > 60)
})

test("production four-turn scores match an unpruned tree across narrow alpha-beta windows", () => {
  let seed = 13413,
    positions = 0,
    roots = 0
  for (let round = 0; round < 8 && positions < 16; round++) {
    let game = createGame()
    for (
      let ply = 0;
      ply < 100 && game.status === "playing" && positions < 16;
      ply++
    ) {
      const moves = legalMoves(game.board, game.turn)
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      game = applyMove(game, moves[seed % moves.length])
      if (game.turn !== "ai" || game.status !== "playing" || ply % 4) continue
      const outcomes = analyzeTacticalMoves(game)
      if (outcomes.some((outcome) => outcome.completeTurnsChecked !== 4))
        continue
      for (const outcome of outcomes) {
        const first = sow(game.board, "ai", outcome.pit)
        assert.equal(
          outcome.checkedScore,
          exhaustive(
            first.board,
            first.turn,
            first.status,
            4 - Number(first.turn !== "ai")
          )
        )
        roots++
      }
      positions++
    }
  }
  assert.equal(positions, 16)
  assert.ok(roots >= 60)
})
