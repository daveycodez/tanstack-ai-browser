import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, legalMoves, newGame } from "../src/lib/checkers.ts"
import { annotateMoves } from "../src/lib/move-outcomes.ts"
import { buildMovePrompt } from "../src/lib/shared-prompt.ts"
import { acceptedChoices, auditCase, inspectChoices } from "./audit.ts"
import { DEFENSIVE_GAME_HISTORY, DEFENSIVE_REGRESSIONS } from "./defensive-regressions.ts"
import { gameForCase } from "./fixtures.ts"

const at = (ply: number) => DEFENSIVE_GAME_HISTORY.slice(0, ply - 1).reduce((game, id) => applyMove(game, id), newGame())

test("reported defensive positions replay legal history and retain all tied smallest-loss choices", () => {
  assert.equal(DEFENSIVE_GAME_HISTORY.length, 49)
  assert.equal(DEFENSIVE_GAME_HISTORY.reduce((game, id) => applyMove(game, id), newGame()).status, "human-won")
  for (const [index, fixture] of DEFENSIVE_REGRESSIONS.entries()) {
    const game = gameForCase(fixture), choices = inspectChoices(game)
    const bad = choices.find(choice => choice.id === (index === 0 ? "f6-g5" : "f4-e5"))
    assert.ok(bad)
    assert.equal(bad.worstNet, index === 0 ? -4 : -3)
    assert.ok(choices.every(choice => choice.worstNet < 0))
    assert.equal(choices.filter(choice => fixture.expectedMoveIds?.includes(choice.id)).length, 3)
    assert.ok(choices.filter(choice => fixture.expectedMoveIds?.includes(choice.id)).every(choice => choice.worstNet === -1 && !choice.humanWins))
    assert.deepEqual(new Set(auditCase(fixture).expectedMoveIds), new Set(fixture.expectedMoveIds))
    assert.throws(() => auditCase({...fixture,expectedMoveIds:fixture.expectedMoveIds?.slice(0, 1) ?? null}), /declared expectation/)
    assert.throws(() => auditCase({...fixture,expectedMoveIds:[bad.id]}), /declared expectation/)
    // Material defense may still concede a promotion; do not ban all crown replies.
    assert.ok(choices.filter(choice => fixture.expectedMoveIds?.includes(choice.id)).every(choice => choice.permitsPromotion))
    const annotations = annotateMoves(game)
    for (const choice of choices) assert.equal(annotations.find(move => move.id === choice.id)?.outcome.worstNetAfterResponse, choice.worstNet)
    const prompt = buildMovePrompt(game)
    assert.deepEqual(new Set(prompt.choices.map(choice => choice.id)), new Set(legalMoves(game.board, "ai").map(move => move.id)))
    assert.ok(prompt.choices.some(choice => choice.id === bad.id), "the model still sees every legal alternative")
    const summary = prompt.prompt.split("\n").find(line => line.startsWith("SMALLEST CHECKED LOSS:"))
    assert.ok(summary)
    assert.match(summary, /Black net -1:/)
    for (const choice of prompt.choices) assert.equal(summary.includes(choice.label), fixture.expectedMoveIds?.includes(choice.id))
  }
})

test("the reported double-jump crown is avoidable but not every other move is equally safe", () => {
  const before = at(44), bad = applyMove(before, "f6-g5")
  assert.deepEqual(legalMoves(bad.board, "human").map(move => move.id), ["h4xf6xh8"])
  const promoted = applyMove(bad, "h4xf6xh8")
  assert.equal(promoted.history.at(-1)?.captures.length, 2)
  assert.equal(promoted.history.at(-1)?.promoted, true)
  assert.deepEqual(new Set(acceptedChoices(before, "minimize-checked-loss")), new Set(["f6-e5", "h6-g5", "f4-g3"]))
})

test("offering the last king forces defeat while the accepted defenses keep playing", () => {
  let game = applyMove(at(46), "f4-e5")
  for (const id of ["d6xf4", "h6-g5", "f4xh6"]) {
    assert.deepEqual(legalMoves(game.board, game.turn).map(move => move.id), [id])
    game = applyMove(game, id)
  }
  assert.equal(game.status, "human-won")
  for (const id of DEFENSIVE_REGRESSIONS[1].expectedMoveIds ?? []) {
    const defense = applyMove(at(46), id)
    assert.equal(defense.status, "playing")
    assert.ok(legalMoves(defense.board, "human").every(reply => applyMove(defense, reply.id).status === "playing"))
  }
})

test("compensated captures and crowning stay available before the two actual blunders", () => {
  const game = at(36), moves = legalMoves(game.board, "ai"), choices = annotateMoves(game, moves)
  assert.equal(moves.length, 2)
  assert.ok(choices.every(move => move.promotes && move.captures.length === 2 && move.outcome.worstNetAfterResponse === 2 && move.outcome.redPromotionReplies === 1))
  assert.deepEqual(new Set(buildMovePrompt(game).choices.map(choice => choice.id)), new Set(moves.map(move => move.id)))
})
