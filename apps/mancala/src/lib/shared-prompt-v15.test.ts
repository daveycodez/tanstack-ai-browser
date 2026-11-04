import assert from "node:assert/strict"
import test from "node:test"
import { createGame, legalMoves } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { buildMovePrompt, PROMPT_VERSIONS } from "./shared-prompt.ts"
import {
  buildMovePrompt as buildV14,
  PROMPT_VERSIONS as HISTORICAL_VERSIONS
} from "./shared-prompt-v14.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"

// Loaded from matched12-candidate-proofs.json, independently terminal-proved.
const MATCHED = [
  {
    game: 1,
    move: 24,
    board: [0, 0, 1, 9, 1, 1, 16, 0, 0, 1, 2, 9, 0, 8],
    oldPit: 11,
    bestPits: [10]
  },
  {
    game: 7,
    move: 27,
    board: [0, 0, 1, 9, 0, 1, 17, 0, 0, 1, 1, 10, 0, 8],
    oldPit: 11,
    bestPits: [10]
  }
]
// Freeze the old21 IDs so adding the two new source cases does not broaden this assertion.
const HISTORICAL_IDS = new Set([
  "bonus-steal-defense",
  "safe-capture-over-exposure",
  "opening",
  "bonus-followthrough",
  "capture-or-bonus",
  "large-capture",
  "chain-into-capture",
  "avoid-big-recapture",
  "compare-bonus-chains",
  "equal-captures",
  "defend-while-sowing",
  "long-lap",
  "winning-sweep",
  "save-the-draw",
  "tied-wins",
  "empty-opposite",
  "sol-match-preserve-margin",
  "sol-match-save-forced-draw",
  "holdout-bonus",
  "holdout-defense",
  "holdout-capture"
])
const position = (board: number[]): Game => ({
  ...createGame(),
  board: board.slice(),
  turn: "ai"
})
function modelFields(input: ReturnType<typeof buildMovePrompt>) {
  return {
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    choices: input.choices,
    report: input.report,
    priorityPits: input.priorityPits,
    recommendedAction: input.recommendedAction
  }
}
const selectedPit = (input: ReturnType<typeof buildMovePrompt>) =>
  input.choices.find((choice) => choice.label === input.recommendedAction)?.id

test("both genuine old14 losing recommendations become the uniquely proved winning action", () => {
  for (const fixture of MATCHED) {
    const game = position(fixture.board)
    const old = buildV14(game)
    const current = buildMovePrompt(game)
    assert.equal(selectedPit(old), fixture.oldPit)
    assert.deepEqual(old.priorityPits, [fixture.oldPit])
    assert.equal(old.finalComparison?.complete, false)
    assert.equal(old.finalComparison?.reason, "node-limit")
    assert.equal(current.version, "shared-v15")
    assert.equal(current.outcomeComparison?.complete, true)
    assert.equal(
      current.outcomeComparison?.moves.find(
        (move) => move.pit === fixture.oldPit
      )?.outcome,
      "human-win"
    )
    assert.deepEqual(current.priorityPits, fixture.bestPits)
    assert.equal(selectedPit(current), 10)
    assert.deepEqual(
      current.choices.map((choice) => [choice.id, choice.label]),
      old.choices.map((choice) => [choice.id, choice.label])
    )
    assert.deepEqual(
      current.choices.map((choice) => choice.id),
      legalMoves(game.board, "ai")
    )
    assert.deepEqual(current.analysis, old.analysis)
    assert.equal(current.prompt.match(/RECOMMENDED AI ACTION:/g)?.length, 1)
    assert.match(current.prompt, /FULL-GAME OUTCOME REVIEW/)
    assert.doesNotMatch(
      current.prompt,
      /opponent capture exposure|own turn|AI margin|exact final AI /
    )
    assert.ok(current.report?.evaluationScope)
    for (const choice of current.choices) {
      const row = current.report?.actions.find(
        (action) => action.label === choice.label
      )
      const previous = old.report?.actions.find(
        (action) => action.label === choice.label
      )
      assert.ok(row && previous)
      assert.deepEqual(row.now, previous.now)
      assert.deepEqual(row.evaluation, previous.evaluation)
      assert.equal(row.preferred, choice.id === 10)
      assert.equal(
        row.resultForAI,
        choice.id === 10
          ? "WIN"
          : fixture.game === 7 && choice.id === 9
            ? "DRAW"
            : "LOSS"
      )
      assert.equal(row.outcomeProof?.kind, "FULL_GAME_OUTCOME")
      assert.equal(
        row.outcomeProof?.outcome,
        current.outcomeComparison?.moves.find((move) => move.pit === choice.id)
          ?.outcome
      )
      assert.equal(row.ownTurn, undefined)
      assert.equal(row.opponentReply, undefined)
      assert.match(
        choice.outcome,
        choice.id === 10 ? /BEST.*PROVED WIN/ : /OTHER.*PROVED (DRAW|DEFEAT)/
      )
      assert.equal(Object.hasOwn(row.outcomeProof ?? {}, "finalMargin"), false)
    }
  }
})

test("reversed presentation keeps the winning label and leaves the game untouched", () => {
  for (const fixture of MATCHED) {
    const game = position(fixture.board)
    const before = structuredClone(game)
    const moves = legalMoves(game.board, "ai").reverse()
    const current = buildMovePrompt(game, moves)
    assert.equal(selectedPit(current), 10)
    assert.deepEqual(current.priorityPits, [10])
    assert.deepEqual(
      current.choices.map((choice) => choice.id),
      moves
    )
    assert.deepEqual(game, before)
  }
})

test("all old21 model-facing fields remain exactly unchanged when their recommendation has the best proved class", () => {
  const fixtures = CASES.filter((fixture) => HISTORICAL_IDS.has(fixture.id))
  assert.equal(fixtures.length, 21)
  for (const fixture of fixtures) {
    const game = gameForCase(fixture)
    const old = buildV14(game)
    const current = buildMovePrompt(game)
    assert.deepEqual(modelFields(current), modelFields(old), fixture.id)
    assert.equal(current.version, "shared-v15")
  }
})

test("every historical version delegates without changing any historical input field", () => {
  const game = { ...createGame(), turn: "ai" as const }
  assert.deepEqual(PROMPT_VERSIONS, [...HISTORICAL_VERSIONS, "shared-v15"])
  assert.equal(HISTORICAL_VERSIONS.length, 14)
  for (const version of HISTORICAL_VERSIONS)
    assert.deepEqual(
      buildMovePrompt(game, undefined, version),
      buildV14(game, undefined, version),
      version
    )
})

test("an incomplete eligible full-game proof cannot alter old recommendations or model strings", () => {
  const game = position([2, 2, 2, 2, 2, 2, 12, 2, 2, 2, 2, 2, 2, 12])
  const old = buildV14(game)
  assert.equal(
    old.report?.actions.find((action) => action.label === old.recommendedAction)
      ?.resultForAI,
    "UNPROVED"
  )
  const current = buildMovePrompt(game)
  assert.equal(current.outcomeComparison?.complete, false)
  assert.equal(current.outcomeComparison?.reason, "node-limit")
  assert.equal(current.outcomeComparison?.nodes, 1_000_000)
  assert.deepEqual(current.outcomeComparison?.moves, [])
  assert.deepEqual(modelFields(current), modelFields(old))
})

test("above-threshold, subset, forced, immediate-win and already-proved-win cases skip WDL work", () => {
  const opening = { ...createGame(), turn: "ai" as const }
  const subset = position(MATCHED[0].board)
  const single = position([1, 0, 0, 0, 0, 0, 23, 0, 0, 0, 0, 0, 1, 23])
  const immediateCase = CASES.find((fixture) => fixture.id === "winning-sweep")
  const winnerCase = CASES.find((fixture) => fixture.id === "capture-or-bonus")
  assert.ok(immediateCase)
  assert.ok(winnerCase)
  const immediate = gameForCase(immediateCase)
  const winner = gameForCase(winnerCase)
  const winnerOld = buildV14(winner)
  assert.equal(winnerOld.finalComparison?.complete, false)
  assert.equal(
    winnerOld.report?.actions.find(
      (action) => action.label === winnerOld.recommendedAction
    )?.resultForAI,
    "WIN"
  )
  for (const [game, moves] of [
    [opening, undefined],
    [subset, [9, 11]],
    [single, undefined],
    [immediate, undefined],
    [winner, undefined]
  ] as const) {
    const old = buildV14(game, moves)
    const current = buildMovePrompt(game, moves)
    assert.equal(current.outcomeComparison, undefined)
    assert.deepEqual(modelFields(current), modelFields(old))
  }
})
