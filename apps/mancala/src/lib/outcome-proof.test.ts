import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, createGame, legalMoves, sow } from "./mancala.ts"
import type { Board, Game, GameStatus, Side } from "./mancala.ts"
import { solveGameOutcomes } from "./outcome-proof.ts"
import type { GameOutcome } from "./outcome-proof.ts"

const position = (board: number[]): Game => ({
  ...createGame(),
  board: board.slice(),
  turn: "ai"
})
const matched = [
  {
    name: "G1 move24",
    board: [0, 0, 1, 9, 1, 1, 16, 0, 0, 1, 2, 9, 0, 8],
    values: [
      [9, "human-win"],
      [10, "ai-win"],
      [11, "human-win"]
    ]
  },
  {
    name: "G7 move27",
    board: [0, 0, 1, 9, 0, 1, 17, 0, 0, 1, 1, 10, 0, 8],
    values: [
      [9, "draw"],
      [10, "ai-win"],
      [11, "human-win"]
    ]
  }
] as const
function permutations(values: number[]): number[][] {
  return values.length
    ? values.flatMap((value, i) =>
        permutations(values.filter((_, j) => i !== j)).map((rest) => [
          value,
          ...rest
        ])
      )
    : [[]]
}
const ordered = (moves: { pit: number; outcome: GameOutcome }[]) =>
  [...moves]
    .sort((a, b) => a.pit - b.pit)
    .map((move) => [move.pit, move.outcome])

test("both genuine lost wins are proved for all six root orders within production caps", () => {
  for (const fixture of matched) {
    const game = position([...fixture.board])
    const before = structuredClone(game)
    for (const order of permutations(legalMoves(game.board, "ai"))) {
      const originalOrder = order.slice()
      const result = solveGameOutcomes(game, order)
      assert.equal(result.complete, true, `${fixture.name}: ${order}`)
      assert.equal(result.reason, "solved")
      assert.deepEqual(ordered(result.moves), fixture.values)
      assert.deepEqual(result.bestPits, [10])
      assert.ok(result.nodes <= 1_000_000)
      assert.ok(result.maxTableEntriesUsed <= 75_000)
      assert.deepEqual(order, originalOrder)
      assert.deepEqual(game, before)
      assert.ok(
        result.moves.every(
          (move) =>
            !Object.hasOwn(move, "finalMargin") &&
            !Object.hasOwn(move, "aiStore")
        )
      )
    }
  }
})

test("a global node limit discards even an earlier fully proved root", () => {
  const game = position([0, 0, 0, 2, 0, 0, 23, 1, 1, 0, 1, 1, 1, 18])
  assert.equal(sow(game.board, "ai", 8).status, "ai-won")
  const result = solveGameOutcomes(game, [8, 7, 10, 11, 12], { maxNodes: 1 })
  assert.equal(result.complete, false)
  assert.equal(result.reason, "node-limit")
  assert.equal(result.nodes, 1)
  assert.deepEqual(result.moves, [])
  assert.deepEqual(result.bestPits, [])
  assert.equal(result.maxTableEntriesUsed, 0)
})

test("the exact visit budget succeeds at the boundary and fails without partial claims below it", () => {
  const game = position([0, 0, 0, 0, 0, 1, 23, 0, 0, 0, 0, 1, 1, 22])
  const complete = solveGameOutcomes(game)
  assert.equal(complete.complete, true)
  assert.ok(complete.nodes > 1)
  assert.deepEqual(
    solveGameOutcomes(game, undefined, { maxNodes: complete.nodes }),
    complete
  )
  const limited = solveGameOutcomes(game, undefined, {
    maxNodes: complete.nodes - 1
  })
  assert.equal(limited.reason, "node-limit")
  assert.equal(limited.nodes, complete.nodes - 1)
  assert.deepEqual(limited.moves, [])
  assert.deepEqual(limited.bestPits, [])
})

test("strict secured majorities, a terminal capture/sweep draw, and 24-seed non-wins are classified correctly", () => {
  for (const [human, ai, outcome] of [
    [12, 30, "ai-win"],
    [30, 12, "human-win"]
  ] as const) {
    const game = position([1, 1, 1, 0, 0, 0, human, 1, 1, 1, 0, 0, 0, ai])
    const result = solveGameOutcomes(game)
    assert.equal(result.complete, true)
    assert.ok(result.moves.every((move) => move.outcome === outcome))
    assert.deepEqual(result.bestPits, [7, 8, 9])
    assert.equal(result.maxTableEntriesUsed, 0)
  }
  const swept = position([0, 0, 2, 0, 0, 0, 24, 1, 0, 1, 0, 0, 0, 20])
  const landing = sow(swept.board, "ai", 9)
  assert.equal(landing.status, "draw")
  assert.equal(landing.captured, 3)
  assert.equal(landing.swept.ai, 1)
  const result = solveGameOutcomes(swept)
  assert.equal(result.complete, true)
  assert.equal(result.moves.find((move) => move.pit === 9)?.outcome, "draw")
  const balanced = solveGameOutcomes(
    position([0, 0, 0, 0, 0, 1, 23, 0, 0, 0, 0, 1, 1, 22])
  )
  assert.deepEqual(balanced.moves, [
    { pit: 11, outcome: "draw" },
    { pit: 12, outcome: "draw" }
  ])
})

test("validation rejects malformed states, unsafe limits and subset proof claims", () => {
  const game = position([...matched[0].board])
  for (const options of [
    { maxNodes: 0 },
    { maxNodes: 1.5 },
    { maxNodes: NaN },
    { maxRemainingSeeds: -1 },
    { maxRemainingSeeds: 25 },
    { maxTableEntries: 0 },
    { maxTableEntries: 75_001 }
  ])
    assert.throws(
      () => solveGameOutcomes(game, undefined, options),
      /threshold up to 24/
    )
  for (const board of [
    [],
    game.board.slice(1),
    [NaN, ...game.board.slice(1)],
    [-1, ...game.board.slice(1)],
    [1.5, ...game.board.slice(1)],
    [49, ...game.board.slice(1)],
    game.board.map((seeds, pit) => (pit === 6 ? seeds - 1 : seeds))
  ])
    assert.throws(() => solveGameOutcomes({ ...game, board }), /totaling 48/)
  const sparse = Array<number>(14)
  sparse[6] = 24
  sparse[13] = 24
  assert.throws(
    () => solveGameOutcomes({ ...game, board: sparse }),
    /totaling 48/
  )
  assert.throws(
    () => solveGameOutcomes({ ...game, turn: "other" as Side }),
    /valid player/
  )
  assert.throws(
    () => solveGameOutcomes({ ...game, status: "unknown" as GameStatus }),
    /valid player/
  )
  assert.throws(() => solveGameOutcomes(game, [9, 10, 10]), /distinct legal/)
  assert.throws(() => solveGameOutcomes(game, [9, 10, 12]), /distinct legal/)
  assert.throws(() => solveGameOutcomes(game, [9, 10]), /Every legal/)
  assert.throws(() => solveGameOutcomes(game, [10]), /Every legal/)
  assert.throws(
    () =>
      solveGameOutcomes(position([0, 0, 0, 0, 0, 0, 24, 1, 1, 1, 1, 1, 1, 18])),
    /both sides/
  )
})

test("out-of-scope games and forced roots allocate no proof search", () => {
  const opening = { ...createGame(), turn: "ai" as const }
  const tooLarge = solveGameOutcomes(opening)
  assert.equal(tooLarge.reason, "too-many-seeds")
  assert.equal(tooLarge.remainingSeeds, 48)
  const human = solveGameOutcomes(createGame())
  assert.equal(human.reason, "not-playing")
  const terminal = solveGameOutcomes({
    ...opening,
    board: [0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 24],
    status: "draw"
  })
  assert.equal(terminal.reason, "not-playing")
  const single = solveGameOutcomes(
    position([1, 0, 0, 0, 0, 0, 23, 0, 0, 0, 0, 0, 1, 23])
  )
  assert.equal(single.reason, "single-choice")
  for (const result of [tooLarge, human, terminal, single]) {
    assert.equal(result.complete, false)
    assert.equal(result.nodes, 0)
    assert.equal(result.maxTableEntriesUsed, 0)
    assert.deepEqual(result.moves, [])
    assert.deepEqual(result.bestPits, [])
  }
})

/** Independent full-board exact oracle: no alpha-beta, bound flags, majority
 * shortcuts, move ordering, or production proof table. Every continuation is
 * evaluated through its terminal sweep; memo entries are exact full states.
 */
function oracle() {
  const table = new Map<string, number>()
  const pitValues = new Map<string, Set<number>>()
  let bonus = false,
    capture = false,
    sweep = false,
    storeCollision = false
  function visit(board: Board, side: Side, status: GameStatus): number {
    if (status !== "playing") return Math.sign(board[13] - board[6])
    const key = `${board.join(",")}:${side}`
    const known = table.get(key)
    if (known !== undefined) return known
    const values = legalMoves(board, side).map((pit) => {
      const next = sow(board, side, pit)
      bonus ||= next.extraTurn
      capture ||= next.captured > 0
      sweep ||= next.swept.ai + next.swept.human > 0
      return visit(next.board, next.turn, next.status)
    })
    assert.ok(values.length)
    const value = side === "ai" ? Math.max(...values) : Math.min(...values)
    table.set(key, value)
    const pitsOnly = `${board.filter((_, pit) => pit !== 6 && pit !== 13).join(",")}:${side}`
    const variants = pitValues.get(pitsOnly) ?? new Set<number>()
    variants.add(value)
    pitValues.set(pitsOnly, variants)
    storeCollision ||= variants.size > 1
    return value
  }
  return {
    visit,
    stats: () => ({ bonus, capture, sweep, storeCollision, states: table.size })
  }
}

test("bounded FIFO tables and alpha-beta flags match an unpruned oracle across reachable endgames", () => {
  let seed = 731,
    checked = 0,
    roots = 0
  let sawBonus = false,
    sawCapture = false,
    sawSweep = false,
    sawStoreCollision = false
  const distinct = new Set<string>()
  for (let round = 0; round < 300 && checked < 40; round++) {
    let game = createGame()
    for (
      let ply = 0;
      ply < 250 && game.status === "playing" && checked < 40;
      ply++
    ) {
      const remaining = 48 - game.board[6] - game.board[13]
      const key = game.board.join(",")
      const moves = legalMoves(game.board, game.turn)
      if (
        game.turn === "ai" &&
        remaining <= 10 &&
        moves.length > 1 &&
        !distinct.has(key)
      ) {
        distinct.add(key)
        const independent = oracle()
        const currentBoard = game.board
        const values = moves.map((pit) => {
          const next = sow(currentBoard, "ai", pit)
          const value = independent.visit(next.board, next.turn, next.status)
          return {
            pit,
            outcome: value > 0 ? "ai-win" : value < 0 ? "human-win" : "draw"
          }
        })
        const before = structuredClone(game)
        for (const maxTableEntries of [1, 2, 7, 75_000]) {
          for (const order of [moves, moves.slice().reverse()]) {
            const proved = solveGameOutcomes(game, order, { maxTableEntries })
            assert.equal(proved.complete, true)
            assert.deepEqual(
              [...proved.moves].sort((a, b) => a.pit - b.pit),
              values
            )
            assert.ok(proved.maxTableEntriesUsed <= maxTableEntries)
          }
        }
        assert.deepEqual(game, before)
        const facts = independent.stats()
        sawBonus ||= facts.bonus
        sawCapture ||= facts.capture
        sawSweep ||= facts.sweep
        sawStoreCollision ||= facts.storeCollision
        checked++
        roots += moves.length
      }
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      game = applyMove(game, moves[seed % moves.length])
    }
  }
  assert.equal(checked, 40)
  assert.ok(roots > 80)
  assert.equal(sawBonus && sawCapture && sawSweep, true)
  assert.equal(
    sawStoreCollision,
    true,
    "same live pits and side can have different outcomes when stores differ"
  )
})

test("equal pit layouts with swapped secured stores retain different proved outcomes", () => {
  const a = [1, 0, 1, 0, 0, 1, 20, 1, 1, 0, 0, 0, 1, 22]
  const b = a.slice()
  b[6] = 22
  b[13] = 20
  const independent = oracle()
  for (const board of [a, b]) {
    const game = position(board)
    const result = solveGameOutcomes(game)
    assert.equal(result.complete, true)
    for (const move of result.moves) {
      const next = sow(board, "ai", move.pit)
      const value = independent.visit(next.board, next.turn, next.status)
      assert.equal(
        move.outcome,
        value > 0 ? "ai-win" : value < 0 ? "human-win" : "draw"
      )
    }
  }
  assert.notDeepEqual(
    solveGameOutcomes(position(a)).moves,
    solveGameOutcomes(position(b)).moves
  )
})
