import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, createGame, legalMoves, sow } from "./mancala.ts"
import type { Board, Game, GameStatus, Side } from "./mancala.ts"
import { solveEndgameTies } from "./endgame-ties.ts"

const position = (board: number[]): Game => ({
  ...createGame(),
  board,
  turn: "ai"
})
const fixture = () => position([1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13])

/** Deliberately unpruned oracle keeps the FULL board, including both stores. */
function oracle(
  board: Board,
  turn: Side,
  status: GameStatus,
  table = new Map<string, number>()
): number {
  if (status !== "playing") return board[13] - board[6]
  const key = `${board.join(",")}:${turn}`
  const cached = table.get(key)
  if (cached !== undefined) return cached
  const values = legalMoves(board, turn).map((pit) => {
    const next = sow(board, turn, pit)
    return oracle(next.board, next.turn, next.status, table)
  })
  assert.ok(values.length)
  const result = turn === "ai" ? Math.max(...values) : Math.min(...values)
  table.set(key, result)
  return result
}

test("the disputed tied move preserves a win but loses ten seeds of exact terminal margin", () => {
  const game = fixture(),
    before = structuredClone(game)
  const result = solveEndgameTies(game, [11, 12])
  assert.equal(result.complete, true)
  assert.equal(result.reason, "solved")
  assert.equal(result.remainingSeeds, 22)
  assert.ok(result.nodes < 600_000)
  assert.deepEqual(result.bestPits, [11])
  assert.deepEqual(
    result.moves.map(
      ({ pit, finalMargin, aiStore, humanStore, bestAiTurn }) => ({
        pit,
        finalMargin,
        aiStore,
        humanStore,
        bestAiTurn
      })
    ),
    [
      {
        pit: 11,
        finalMargin: 12,
        aiStore: 30,
        humanStore: 18,
        bestAiTurn: [11, 8]
      },
      { pit: 12, finalMargin: 2, aiStore: 25, humanStore: 23, bestAiTurn: [12] }
    ]
  )
  for (const move of result.moves) {
    assert.deepEqual(
      move.principalLine,
      move.bestAiTurn.map((pit) => ({ side: "ai", pit }))
    )
    let board = game.board
    let next
    for (const action of move.principalLine) {
      next = sow(board, "ai", action.pit)
      board = next.board
    }
    assert.ok(next)
    assert.equal(next.turn, "human")
  }
  assert.deepEqual(game, before)
})

test("reversing the supplied tie order preserves complete terminal margins and exact own-turn plans", () => {
  const result = solveEndgameTies(fixture(), [12, 11])
  assert.equal(result.complete, true)
  assert.deepEqual(result.bestPits, [11])
  assert.deepEqual(
    result.moves.map((move) => [move.pit, move.finalMargin, move.bestAiTurn]),
    [
      [12, 2, [12]],
      [11, 12, [11, 8]]
    ]
  )
  assert.ok(result.nodes < 600_000)
})

test("hitting a global node limit discards every partial score and ranking", () => {
  const result = solveEndgameTies(fixture(), [11, 12], { maxNodes: 1 })
  assert.equal(result.complete, false)
  assert.equal(result.reason, "node-limit")
  assert.equal(result.nodes, 1)
  assert.deepEqual(result.moves, [])
  assert.deepEqual(result.bestPits, [])
})

test("opening positions and single candidates avoid an exact-search allocation", () => {
  const large = { ...createGame(), turn: "ai" as const }
  const opening = solveEndgameTies(large, legalMoves(large.board, "ai"))
  assert.equal(opening.reason, "too-many-seeds")
  assert.equal(opening.nodes, 0)
  assert.deepEqual(opening.bestPits, [])
  const single = solveEndgameTies(fixture(), [11])
  assert.equal(single.reason, "single-choice")
  assert.equal(single.nodes, 0)
  assert.equal(
    solveEndgameTies({ ...fixture(), turn: "human" }, [11, 12]).reason,
    "not-playing"
  )
})

test("terminal sweeps and bonus continuations include the same exact final score", () => {
  const game = position([0, 0, 0, 2, 0, 0, 23, 1, 1, 0, 1, 1, 1, 18])
  const result = solveEndgameTies(game, [8, 12])
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.moves.map((move) => [
      move.pit,
      move.finalMargin,
      move.aiStore,
      move.humanStore
    ]),
    [
      [8, 2, 25, 23],
      [12, 2, 25, 23]
    ]
  )
  assert.deepEqual(
    result.moves.map((move) => move.bestAiTurn),
    [[8], [12, 8]]
  )
})

test("bounded TT search matches an independent full-store unpruned oracle, including an already secured majority", () => {
  for (const board of [
    [1, 0, 1, 0, 0, 1, 20, 1, 1, 0, 0, 0, 1, 22],
    [0, 1, 0, 1, 1, 0, 21, 0, 0, 1, 0, 1, 1, 21],
    [1, 0, 0, 0, 1, 0, 25, 1, 1, 0, 0, 0, 1, 18]
  ]) {
    const game = position(board),
      candidates = legalMoves(board, "ai")
    const result = solveEndgameTies(game, candidates, { maxTableEntries: 1 })
    assert.equal(result.complete, true)
    for (const move of result.moves) {
      const next = sow(board, "ai", move.pit)
      assert.equal(move.finalMargin, oracle(next.board, next.turn, next.status))
      assert.equal(move.aiStore + move.humanStore, 48)
    }
  }
})

test("stores-neutral transpositions add the initial secured margin exactly", () => {
  const first = [1, 0, 1, 0, 0, 1, 20, 1, 1, 0, 0, 0, 1, 22]
  const second = first.slice()
  second[6] = 22
  second[13] = 20
  const a = solveEndgameTies(position(first), [7, 8, 12])
  const b = solveEndgameTies(position(second), [7, 8, 12])
  assert.equal(a.complete && b.complete, true)
  for (let i = 0; i < a.moves.length; i++)
    assert.equal(a.moves[i].finalMargin - b.moves[i].finalMargin, 4)
})

test("invalid choices and resource limits cannot create a ranking", () => {
  assert.throws(() => solveEndgameTies(fixture(), [11, 11]), /distinct legal/)
  assert.throws(() => solveEndgameTies(fixture(), [0, 12]), /distinct legal/)
  assert.throws(
    () => solveEndgameTies(fixture(), [11, 12], { maxNodes: 0 }),
    /positive integer/
  )
  assert.throws(
    () => solveEndgameTies(fixture(), [11, 12], { maxRemainingSeeds: 23 }),
    /up to 22/
  )
})

test("the next bonus decision follows the proved optimal endgame continuation", () => {
  const next = applyMove(fixture(), 11)
  const result = solveEndgameTies(next, [7, 8, 12])
  assert.equal(next.turn, "ai")
  assert.equal(result.complete, true)
  assert.deepEqual(result.bestPits, [8])
  assert.deepEqual(
    result.moves.map((move) => [move.pit, move.finalMargin]),
    [
      [7, 8],
      [8, 12],
      [12, 6]
    ]
  )
  assert.ok(result.nodes < 1_000_000)
})
