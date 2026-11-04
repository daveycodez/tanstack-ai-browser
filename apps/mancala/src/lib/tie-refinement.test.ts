import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { createGame } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { solveEndgameTies } from "./endgame-ties.ts"
import { analyzeTacticalMoves } from "./move-outcomes.ts"
import { refineTiedChoices } from "./tie-refinement.ts"

const move16 = [5, 1, 0, 3, 1, 0, 10, 0, 0, 0, 10, 8, 8, 2]
const move26 = [1, 1, 0, 8, 0, 1, 17, 1, 1, 0, 0, 9, 1, 8]
const position = (board: number[]): Game => ({
  ...createGame(),
  board: board.slice(),
  turn: "ai"
})

test("the 23-seed real-game tie uses an explicit expanded terminal threshold", () => {
  const game = position(move26)
  const baseline = analyzeTacticalMoves(game)
  assert.deepEqual(
    baseline
      .filter((outcome) => outcome.checkedScore === -3)
      .map((outcome) => outcome.pit),
    [8, 12]
  )
  const historical = solveEndgameTies(game, [8, 12])
  assert.equal(historical.complete, false)
  assert.equal(historical.reason, "too-many-seeds")
  assert.equal(historical.remainingSeeds, 23)
  assert.equal(historical.nodes, 0)
  const result = refineTiedChoices(game, [8, 12], 4, { baseline })
  assert.equal(result.kind, "exact")
  if (result.kind !== "exact") return
  assert.equal(result.horizon, null)
  assert.equal(result.endgame.complete, true)
  assert.deepEqual(result.bestPits, [12])
  assert.deepEqual(
    result.endgame.moves.map((outcome) => [outcome.pit, outcome.finalMargin]),
    [
      [8, -8],
      [12, -6]
    ]
  )
  assert.equal(result.nodes, result.endgame.nodes)
  assert.ok(result.nodes <= 1_000_000)
})

test("deeper complete-turn evidence separates the real-game midgame tie without claiming a terminal margin", () => {
  const game = position(move16)
  const baseline = analyzeTacticalMoves(game)
  assert.deepEqual(
    baseline
      .filter((outcome) => outcome.checkedScore === -10)
      .map((outcome) => outcome.pit),
    [10, 12]
  )
  const result = refineTiedChoices(game, [10, 12], 4, { baseline })
  assert.equal(result.kind, "bounded")
  if (result.kind !== "bounded") return
  assert.equal(result.horizon, 8)
  assert.equal(result.endgame.reason, "too-many-seeds")
  assert.deepEqual(result.bestPits, [10])
  assert.deepEqual(
    result.outcomes.map((outcome) => [
      outcome.pit,
      outcome.checkedScore,
      outcome.guaranteedOutcome
    ]),
    [
      [10, -10, undefined],
      [12, -1022, "human-win"]
    ]
  )
  assert.ok(
    result.outcomes.every(
      (outcome) => outcome.complete && outcome.completeTurnsChecked === 8
    )
  )
  assert.equal(
    result.nodes,
    result.outcomes.reduce(
      (sum, outcome) => sum + outcome.nodes,
      result.endgame.nodes
    )
  )
  assert.ok(result.outcomes.every((outcome) => outcome.nodes <= 60_000))
})

test("only a fully complete common deeper horizon is compared, including odd-turn fallbacks", () => {
  const game = position(move16)
  const result = refineTiedChoices(game, [10, 12], 4, {
    baseline: analyzeTacticalMoves(game),
    maxNodesPerMove: 2_000
  })
  assert.equal(result.kind, "bounded")
  if (result.kind !== "bounded") return
  assert.equal(result.horizon, 5)
  assert.deepEqual(result.bestPits, [10, 12])
  assert.ok(
    result.outcomes.every(
      (outcome) => outcome.complete && outcome.completeTurnsChecked === 5
    )
  )
  assert.ok(result.outcomes.every((outcome) => outcome.nodes > 2_000))
  assert.equal(
    result.nodes,
    result.outcomes.reduce((sum, outcome) => sum + outcome.nodes, 0)
  )
})

test("exhausted terminal and tactical budgets discard partial rankings and count every attempt", () => {
  const game = position(move26)
  const result = refineTiedChoices(game, [8, 12], 4, {
    baseline: analyzeTacticalMoves(game),
    maxEndgameNodes: 1,
    maxNodesPerMove: 1,
    maxSafetyNodes: 1
  })
  assert.equal(result.kind, "unchanged")
  if (result.kind !== "unchanged") return
  assert.equal(result.reason, "incomplete-search")
  assert.equal(result.horizon, 4)
  assert.deepEqual(result.bestPits, [8, 12])
  assert.equal(result.endgame?.reason, "node-limit")
  assert.deepEqual(result.endgame?.moves, [])
  assert.equal("outcomes" in result, false)
  const incomplete = analyzeTacticalMoves(game, [8, 12], {
    turns: 8,
    minimumTurns: 5,
    maxNodesPerMove: 1,
    maxSafetyNodes: 1
  })
  assert.ok(
    incomplete.every(
      (outcome) =>
        !outcome.complete &&
        outcome.checkedScore === null &&
        outcome.completeTurnsChecked === 0
    )
  )
  assert.equal(
    result.nodes,
    1 + incomplete.reduce((sum, outcome) => sum + outcome.nodes, 0)
  )
})

test("single choices, non-ties and incomplete baselines do no deeper search", () => {
  const game = position(move16)
  const baseline = analyzeTacticalMoves(game)
  const options = { baseline, maxEndgameNodes: 1, maxNodesPerMove: 1 }
  const single = refineTiedChoices(game, [10], 4, options)
  assert.equal(single.kind === "unchanged" && single.reason, "single-choice")
  assert.equal(single.nodes, 0)
  const notTied = refineTiedChoices(game, [10, 11, 12], 4, options)
  assert.equal(notTied.kind === "unchanged" && notTied.reason, "not-tied")
  assert.equal(notTied.nodes, 0)
  const incomplete = refineTiedChoices(game, [10, 12], 4, {
    ...options,
    baseline: baseline.map((outcome) =>
      outcome.pit === 10 ? { ...outcome, complete: false } : outcome
    )
  })
  assert.equal(
    incomplete.kind === "unchanged" && incomplete.reason,
    "incomplete-baseline"
  )
  assert.equal(incomplete.nodes, 0)
  assert.throws(
    () => refineTiedChoices(game, [10, 10], 4, options),
    /distinct legal/
  )
  assert.throws(
    () => refineTiedChoices(game, [6, 12], 4, options),
    /distinct legal/
  )
  assert.throws(
    () => refineTiedChoices(game, [10, 12], 4, { baseline: baseline.slice(1) }),
    /every current legal/
  )
  assert.throws(
    () =>
      refineTiedChoices(game, [10, 12], 4, { ...options, maxEndgameNodes: 0 }),
    /positive integer/
  )
})

test("candidate and baseline order preserve refined scores without mutating inputs", () => {
  for (const [board, candidates] of [
    [move16, [10, 12]],
    [move26, [8, 12]]
  ] as const) {
    const game = position(board)
    const baseline = analyzeTacticalMoves(game)
    const before = structuredClone({ game, baseline, candidates })
    const normal = refineTiedChoices(game, candidates, 4, { baseline })
    const reversed = refineTiedChoices(game, [...candidates].reverse(), 4, {
      baseline: [...baseline].reverse()
    })
    assert.equal(reversed.kind, normal.kind)
    assert.deepEqual([...reversed.bestPits].sort(), [...normal.bestPits].sort())
    if (normal.kind === "exact" && reversed.kind === "exact")
      assert.deepEqual(
        [...reversed.endgame.moves]
          .sort((a, b) => a.pit - b.pit)
          .map((outcome) => [outcome.pit, outcome.finalMargin]),
        normal.endgame.moves.map((outcome) => [
          outcome.pit,
          outcome.finalMargin
        ])
      )
    if (normal.kind === "bounded" && reversed.kind === "bounded") {
      assert.equal(reversed.horizon, normal.horizon)
      assert.deepEqual(
        [...reversed.outcomes].sort((a, b) => a.pit - b.pit),
        normal.outcomes
      )
    }
    assert.deepEqual({ game, baseline, candidates }, before)
  }
})

test("historical default tactical outputs remain byte-for-byte unchanged", () => {
  // SHA-256 of complete default outcomes captured before widening opt-in limits.
  const fixtures: [number[], string][] = [
    [
      [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0],
      "37a296689da5c5d58ffd0e39992a30b05fd1c8bb3fa6d1b3969e409770cdf8b4"
    ],
    [
      move16,
      "6886d4296915c3998e883d0a6867df269ecb7a3e89c03c844e6f381dfa506f6c"
    ],
    [
      move26,
      "c8954c75facbddfec20397ea36355ebbc60d2ba5e6661d5ea5462da84a97b675"
    ],
    [
      [1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13],
      "5b9d83a5fa8474bf2bde7728f067c9fa471986bae153203e919ab923e6d5cb99"
    ]
  ]
  for (const [board, expected] of fixtures) {
    const outcomes = analyzeTacticalMoves(position(board))
    assert.equal(
      createHash("sha256").update(JSON.stringify(outcomes)).digest("hex"),
      expected
    )
    assert.ok(outcomes.every((outcome) => outcome.completeTurnsChecked <= 4))
  }
})

test("explicit analysis options validate the expanded range and preserve the historical fallback floor", () => {
  const game = position(move16)
  assert.throws(
    () => analyzeTacticalMoves(game, [10, 12], { turns: 9 }),
    /two to eight/
  )
  assert.throws(
    () => analyzeTacticalMoves(game, [10, 12], { turns: 8, minimumTurns: 9 }),
    /minimum horizon/
  )
  assert.throws(
    () => analyzeTacticalMoves(game, [10, 12], { turns: 8, minimumTurns: 1 }),
    /minimum horizon/
  )
  assert.throws(
    () =>
      solveEndgameTies(position(move26), [8, 12], { maxRemainingSeeds: 25 }),
    /up to 24/
  )
  const opening = position([4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0])
  const fallback = analyzeTacticalMoves(opening, undefined, {
    maxNodesPerMove: 100
  })
  assert.ok(
    fallback.every(
      (outcome) => outcome.complete && outcome.completeTurnsChecked === 2
    )
  )
})
