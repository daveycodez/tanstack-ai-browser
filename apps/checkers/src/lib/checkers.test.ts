import assert from "node:assert/strict"
import test from "node:test"
import { boardSteps } from "./board-motion.ts"
import {
  applyMove,
  legalMoves,
  newGame,
  previewBoard,
  squareName,
  type Board,
  type Game,
  type Side
} from "./checkers.ts"

function fixture(
  pieces: [number, Side, boolean?][],
  turn: Side = "human"
): Game {
  const board: Board = Array(64).fill(null)
  for (const [index, side, king = false] of pieces)
    board[index] = { side, king }
  return { ...newGame(), board, turn, positions: [] }
}

test("new games have 12 pieces each, seven opening moves, and independent state", () => {
  const game = newGame()
  assert.equal(game.board.filter((p) => p?.side === "human").length, 12)
  assert.equal(game.board.filter((p) => p?.side === "ai").length, 12)
  assert.equal(legalMoves(game.board, "human").length, 7)
  assert.equal(game.turn, "human")
  assert.equal(game.positions.length, 1)
  assert.notEqual(game.sessionId, newGame().sessionId)
  const moved = applyMove(game, "a3-b4")
  assert.equal(moved.board[40], null)
  assert.deepEqual(moved.board[33], { side: "human", king: false })
  assert.equal(game.board[40]?.side, "human")
  assert.equal(game.history.length, 0)
  assert.equal(moved.history[0]?.notation, "a3-b4")
  assert.equal(moved.turn, "ai")
})

test("mandatory captures suppress steps and require the complete jump chain", () => {
  const game = fixture([
    [42, "human"],
    [56, "human"],
    [35, "ai"],
    [21, "ai"],
    [1, "ai"]
  ])
  assert.deepEqual(legalMoves(game.board, "human"), [
    {
      id: "c3xe5xg7",
      path: [42, 28, 14],
      captures: [35, 21],
      promotes: false
    }
  ])
  assert.throws(() => applyMove(game, "c3xe5"), /Illegal move/)
  const moved = applyMove(game, "c3xe5xg7")
  assert.equal(moved.board[35], null)
  assert.equal(moved.board[21], null)
  assert.equal(moved.board[14]?.side, "human")
  assert.equal(moved.history.length, 1)
})

test("all capture branches are offered without requiring the longest branch", () => {
  const game = fixture([
    [44, "human"],
    [35, "ai"],
    [37, "ai"],
    [17, "ai"]
  ])
  assert.deepEqual(
    legalMoves(game.board, "human")
      .map((m) => m.id)
      .sort(),
    ["e3xc5xa7", "e3xg5"]
  )
})

test("men cannot move or capture backward, while kings can", () => {
  const man = fixture([
    [28, "human"],
    [35, "ai"]
  ])
  assert.ok(
    legalMoves(man.board, "human").every((move) => move.captures.length === 0)
  )
  const king = fixture([
    [28, "human", true],
    [35, "ai"]
  ])
  assert.deepEqual(
    legalMoves(king.board, "human").map((move) => move.id),
    ["e5xc3"]
  )
  const openKing = fixture([[28, "human", true]])
  assert.equal(legalMoves(openKing.board, "human").length, 4)
})

test("promotion ends a capture turn before a newly crowned king could jump backward", () => {
  const game = fixture([
    [18, "human"],
    [11, "ai"],
    [13, "ai"]
  ])
  assert.deepEqual(legalMoves(game.board, "human"), [
    { id: "c6xe8", path: [18, 4], captures: [11], promotes: true }
  ])
  const moved = applyMove(game, "c6xe8")
  assert.deepEqual(moved.board[4], { side: "human", king: true })
  assert.equal(moved.board[13]?.side, "ai")
  assert.equal(moved.history[0]?.promoted, true)
})

test("AI men advance downward and crown on the bottom row", () => {
  const game = fixture(
    [
      [42, "ai"],
      [51, "human"],
      [1, "human"]
    ],
    "ai"
  )
  assert.deepEqual(legalMoves(game.board, "ai"), [
    { id: "c3xe1", path: [42, 60], captures: [51], promotes: true }
  ])
  assert.deepEqual(applyMove(game, "c3xe1").board[60], {
    side: "ai",
    king: true
  })
})

test("previewing an incomplete jump removes only captures already traversed", () => {
  const game = fixture([
    [42, "human"],
    [35, "ai"],
    [21, "ai"]
  ])
  const preview = previewBoard(game.board, [42, 28])
  assert.equal(preview[42], null)
  assert.equal(preview[35], null)
  assert.equal(preview[28]?.side, "human")
  assert.equal(preview[21]?.side, "ai")
  assert.equal(game.board[42]?.side, "human")
  assert.equal(game.board[35]?.side, "ai")
})

test("a side with pieces but no legal moves loses", () => {
  const game = fixture([
    [40, "human"],
    [56, "ai"]
  ])
  assert.equal(applyMove(game, "a3-b4").status, "human-won")
})

test("capturing the final opposing piece wins", () => {
  const game = fixture([
    [42, "human"],
    [35, "ai"]
  ])
  assert.equal(applyMove(game, "c3xe5").status, "human-won")
})

test("third occurrence of the same board and side to move is a draw", () => {
  let game = fixture([
    [40, "human", true],
    [23, "ai", true]
  ])
  game.positions = [
    `human:${".".repeat(23)}A${".".repeat(16)}H${".".repeat(23)}`
  ]
  const cycle = ["a3-b4", "h6-g5", "b4-a3", "g5-h6"]
  for (const id of cycle) game = applyMove(game, id)
  assert.equal(game.status, "playing")
  for (const id of cycle) game = applyMove(game, id)
  assert.equal(game.status, "draw")
  assert.equal(game.history.length, 8)
})

test("80 quiet plies draws, and capture or any man advance resets the count", () => {
  const quiet = {
    ...fixture([
      [40, "human", true],
      [23, "ai", true]
    ]),
    quietMoves: 79
  }
  assert.equal(applyMove(quiet, "a3-b4").status, "draw")
  const man = {
    ...fixture([
      [40, "human"],
      [23, "ai", true]
    ]),
    quietMoves: 79
  }
  assert.equal(applyMove(man, "a3-b4").quietMoves, 0)
  const capture = {
    ...fixture([
      [42, "human", true],
      [35, "ai"],
      [1, "ai"]
    ]),
    quietMoves: 79
  }
  assert.equal(applyMove(capture, "c3xe5").quietMoves, 0)
})

test("illegal moves and moves after game end are rejected", () => {
  assert.throws(() => applyMove(newGame(), "a3-a4"), /Illegal move/)
  assert.throws(
    () => applyMove({ ...newGame(), status: "draw" }, "a3-b4"),
    /already over/
  )
})

test("square names follow a8 at the top left and reject invalid indexes", () => {
  assert.equal(squareName(0), "a8")
  assert.equal(squareName(63), "h1")
  assert.throws(() => squareName(-1), RangeError)
  assert.throws(() => squareName(64), RangeError)
})

test("a king can finish a multi-jump on its original square without recapturing pieces", () => {
  const game = fixture([
    [42, "human", true],
    [35, "ai"],
    [37, "ai"],
    [53, "ai"],
    [51, "ai"]
  ])
  const moves = legalMoves(game.board, "human")
  assert.equal(moves.length, 2)
  assert.ok(
    moves.every((move) => move.captures.length === 4 && move.path.at(-1) === 42)
  )
  const moved = applyMove(game, "c3xe5xg3xe1xc3")
  assert.deepEqual(moved.board[42], { side: "human", king: true })
  assert.equal(moved.board.filter(Boolean).length, 1)
  assert.equal(moved.status, "human-won")
  const playback = boardSteps(game.board, moved.board, moved.history[0].path)
  assert.equal(playback.length, 4, "a return to the origin still animates every capture")
  assert.deepEqual(playback.map(step => step.captured), [35, 37, 53, 51])
  assert.deepEqual(playback.at(-1)?.board, moved.board)
})


test("move playback follows each capture and resumes from a human's completed first jump", () => {
  const game = fixture([[42, "human"], [35, "ai"], [21, "ai"], [1, "ai"]])
  const path = [42, 28, 14]
  const target = applyMove(game, "c3xe5xg7").board
  const steps = boardSteps(game.board, target, path)
  assert.deepEqual(steps.map(step => [step.from, step.to, step.captured]), [[42, 28, 35], [28, 14, 21]])
  assert.equal(steps[0].board[35], null)
  assert.equal(steps[0].board[21]?.side, "ai", "the next captured piece remains until its own jump")
  assert.deepEqual(steps[1].board, target)
  const remaining = boardSteps(steps[0].board, target, path)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].from, 28)
  assert.deepEqual(game.board[35], { side: "ai", king: false }, "playback never mutates persisted state")
})

test("AI playback moves through all jumps and crowns only on the final landing", () => {
  const game = fixture([[21, "ai"], [28, "human"], [42, "human"], [62, "human"]], "ai")
  const move = legalMoves(game.board, "ai")[0]
  const steps = boardSteps(game.board, applyMove(game, move.id).board, move.path)
  assert.equal(steps.length, 2)
  assert.equal(steps[0].promotes, false)
  assert.equal(steps[1].promotes, false)
  const promotion = fixture([[42, "ai"], [51, "human"], [56, "human"]], "ai")
  const crown = legalMoves(promotion.board, "ai")[0]
  const promoted = boardSteps(promotion.board, applyMove(promotion, crown.id).board, crown.path)
  assert.equal(promoted.at(-1)?.promotes, true)
  assert.equal(promoted.at(-1)?.piece.king, false, "the travelling piece is crowned at landing")
  assert.equal(promoted.at(-1)?.board[crown.path.at(-1) ?? -1]?.king, true)
})

test("unrelated or restored snapshots do not invent motion", () => {
  const game = newGame()
  const move = legalMoves(game.board, "human")[0]
  const next = applyMove(game, move.id)
  assert.equal(boardSteps(game.board, next.board, move.path).length, 1)
  assert.deepEqual(boardSteps(game.board, next.board, [42, 28]), [])
  assert.deepEqual(boardSteps(next.board, game.board, move.path), [])
  assert.deepEqual(boardSteps(game.board, game.board, move.path), [])
})
