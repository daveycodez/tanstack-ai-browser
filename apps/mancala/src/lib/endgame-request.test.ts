import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { createEndgameTieRequest, solveEndgameTies } from "./endgame-ties.ts"
import type { EndgameTieSolver } from "./endgame-ties.ts"
import { buildMovePrompt } from "./shared-prompt.ts"

const reproduction = (): Game => ({
  ...createGame(),
  turn: "ai",
  board: [0, 4, 1, 0, 1, 7, 10, 0, 1, 1, 2, 2, 3, 16]
})

test("eligible thresholds share exhausted results without bypassing validation or eligibility", () => {
  const request = createEndgameTieRequest()
  const game = reproduction()
  const first = request.solve(game, [9, 11], { maxNodes: 1 })
  assert.equal(first.reason, "node-limit")
  const repeated = request.solve(game, [9, 11], {
    maxRemainingSeeds: 24,
    maxNodes: 1,
    maxTableEntries: 75_000
  })
  assert.deepEqual(repeated, first)
  assert.notEqual(repeated, first)
  assert.deepEqual(request.stats(), { searches: 1, hits: 1, entries: 1 })
  assert.equal(
    request.solve(game, [9, 11], { maxRemainingSeeds: 21, maxNodes: 1 }).reason,
    "too-many-seeds"
  )
  assert.equal(
    request.solve({ ...game, turn: "human" }, [9, 11]).reason,
    "not-playing"
  )
  assert.equal(
    request.solve({ ...game, status: "draw" }, [9, 11]).reason,
    "not-playing"
  )
  assert.throws(
    () => request.solve(game, [9, 11], { maxRemainingSeeds: 25 }),
    RangeError
  )
  assert.throws(() => request.solve(game, [9, 11], { maxNodes: 0 }), RangeError)
  assert.throws(() => request.solve(game, [9, 9], { maxNodes: 1 }))
  assert.deepEqual(request.stats(), { searches: 1, hits: 1, entries: 1 })
})

test("ordered candidates, full positions and resource limits distinguish searches", () => {
  const request = createEndgameTieRequest()
  const game = reproduction()
  request.solve(game, [9, 11], { maxNodes: 1 })
  request.solve(game, [11, 9], { maxNodes: 1 })
  request.solve(game, [9, 10], { maxNodes: 1 })
  request.solve(game, [9, 11], { maxNodes: 2 })
  request.solve(game, [9, 11], { maxNodes: 1, maxTableEntries: 1 })
  const storesChanged = structuredClone(game)
  storesChanged.board[6]++
  storesChanged.board[13]--
  request.solve(storesChanged, [9, 11], { maxNodes: 1 })
  const pitsChanged = structuredClone(game)
  pitsChanged.board[1]--
  pitsChanged.board[2]++
  request.solve(pitsChanged, [9, 11], { maxNodes: 1 })
  assert.deepEqual(request.stats(), { searches: 7, hits: 0, entries: 4 })
  // The oldest result has been evicted; a request never grows past four entries.
  request.solve(game, [9, 11], { maxNodes: 1 })
  assert.deepEqual(request.stats(), { searches: 8, hits: 0, entries: 4 })
})

test("reused solved results do not share mutable result arrays or continuations", () => {
  const request = createEndgameTieRequest()
  const game: Game = {
    ...createGame(),
    turn: "ai",
    board: [0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16]
  }
  const first = request.solve(game, [7, 10, 12])
  assert.equal(first.complete, true)
  const expected = structuredClone(first)
  const move = first.moves[0]
  assert.ok(move)
  const action = move.principalLine[0]
  assert.ok(action)
  action.pit = 12
  move.bestAiTurn.push(11)
  move.finalMargin = 99
  first.bestPits.length = 0
  const second = request.solve(game, [7, 10, 12], { maxRemainingSeeds: 24 })
  assert.deepEqual(second, expected)
  second.moves.length = 0
  assert.deepEqual(request.solve(game, [7, 10, 12]), expected)
  assert.deepEqual(request.stats(), { searches: 1, hits: 2, entries: 1 })
})

test("separate requests perform their own work", () => {
  const first = createEndgameTieRequest()
  const second = createEndgameTieRequest()
  const game = reproduction()
  assert.deepEqual(
    first.solve(game, [9, 11], { maxNodes: 1 }),
    second.solve(game, [9, 11], { maxNodes: 1 })
  )
  first.solve(game, [9, 11], { maxNodes: 1 })
  assert.deepEqual(first.stats(), { searches: 1, hits: 1, entries: 1 })
  assert.deepEqual(second.stats(), { searches: 1, hits: 0, entries: 1 })
})

test("the real prompt chain skips the duplicated million-node search with identical output", () => {
  const game = reproduction()
  const before = structuredClone(game)
  const calls: number[][] = []
  const uncached: EndgameTieSolver = (position, candidates, options) => {
    calls.push([...candidates])
    return solveEndgameTies(position, candidates, options)
  }
  const expected = buildMovePrompt(game, undefined, "shared-v15", uncached)
  const request = createEndgameTieRequest()
  const actual = buildMovePrompt(game, undefined, "shared-v15", request.solve)
  assert.equal(
    calls.filter((pits) => JSON.stringify(pits) === "[9,11]").length,
    2
  )
  assert.deepEqual(request.stats(), { searches: 2, hits: 1, entries: 2 })
  assert.deepEqual(actual, expected)
  assert.equal(JSON.stringify(actual), JSON.stringify(expected))
  assert.deepEqual(game, before)
})
