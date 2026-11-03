import assert from "node:assert/strict"
import test from "node:test"
import { auditCase } from "../../bench/audit.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
import { RUNNER_REGRESSIONS } from "../../bench/runner-regressions.ts"
import { applyMove, legalMoves } from "./checkers.ts"
import { annotateMoves, describeMove, materialBalance } from "./move-outcomes.ts"
import { buildMovePrompt } from "./shared-prompt.ts"

function reported(ply: number) {
  const fixture = RUNNER_REGRESSIONS.find(item => item.id.endsWith(`-${ply}`))
  assert.ok(fixture)
  const game = gameForCase(fixture)
  assert.equal(game.history.length, ply - 1)
  return { fixture, game }
}

test("move 82 preserves the king-row guard and uses the other king", () => {
  const { fixture, game } = reported(82)
  const moves = annotateMoves(game)
  assert.ok(moves.every(move => move.outcome.redTurnsChecked === 2))
  const abandon = moves.find(move => move.id === "b8-a7")
  const defend = moves.find(move => move.id === "e1-f2")
  assert.ok(abandon && defend)
  assert.equal(abandon.outcome.worstNetAfterResponse, -1)
  assert.equal(defend.outcome.worstNetAfterResponse, 0)
  assert.deepEqual(auditCase(fixture).expectedMoveIds, ["e1-f2"])
  const threat = abandon.outcome.redReplies.find(reply => reply.id === "b6-c7")
  assert.ok(threat)
  assert.equal(threat.netAfterBestResponse, -1)
  assert.deepEqual(threat.exchangeLine, ["b6-c7", "a7-b8", "c7-d8", "b8-a7"])
  assert.match(describeMove(abandon), /Red b6-c7 → Black a7-b8 → Red c7-d8/)
  const safe = buildMovePrompt(game).prompt.split("\n").reverse().find(line => line.startsWith("NON-LOSING CHECKED EXCHANGES:"))
  assert.ok(safe)
  assert.match(safe, /Move king e1 to f2/)
  assert.doesNotMatch(safe, /Move king b8 to a7/)
})

test("the retained guard takes both the runner and its supporting king in a compulsory chain", () => {
  const { game } = reported(82)
  const defended = applyMove(game, "e1-f2")
  const approached = applyMove(defended, "b6-c7")
  assert.deepEqual(legalMoves(approached.board, "ai").map(move => move.id), ["b8xd6xf4"])
  const captured = applyMove(approached, "b8xd6xf4")
  assert.equal(captured.board.filter(piece => piece?.side === "human" && piece.king).length, 0)
  assert.ok(materialBalance(captured.board) > materialBalance(game.board))
  assert.throws(() => applyMove(approached, "b8xd6"), /Illegal move/)
})

test("move 84 is already too late for a material-safe blockade, and remains ungraded", () => {
  const { fixture, game } = reported(84)
  const moves = annotateMoves(game)
  assert.equal(fixture.expectedMoveIds, null)
  assert.ok(moves.every(move => move.outcome.worstNetAfterResponse < 0))
  const halfBlock = moves.find(move => move.id === "a7-b8")
  assert.ok(halfBlock)
  const after = applyMove(game, halfBlock.id)
  assert.ok(legalMoves(after.board, "human").some(move => move.id === "c7-d8" && move.promotes))
  assert.ok(!legalMoves(after.board, "human").some(move => move.id === "c7-b8"))
})

test("a compensated promotion is not automatically graded as a failure", () => {
  const { fixture, game } = reported(48)
  assert.equal(fixture.expectedMoveIds, null)
  const compensated = annotateMoves(game).find(move => move.id === "g1-f2")
  assert.ok(compensated)
  assert.ok(compensated.outcome.redPromotionReplies > 0)
  assert.equal(compensated.outcome.worstNetAfterResponse, 0)
})

test("the promotion horizon is explicit and only expands for an uncrowned near-crown Red runner", () => {
  const { game } = reported(82)
  const original = JSON.stringify(game)
  assert.match(buildMovePrompt(game).prompt, /TWO Red turns and TWO Black responses/)
  assert.equal(JSON.stringify(game), original)
  const kingInstead = { ...game, board: game.board.map((piece, square) => square === 17 && piece ? { ...piece, king: true } : piece) }
  assert.ok(annotateMoves(kingInstead).every(move => move.outcome.redTurnsChecked === 1))
  const openingFixture = CASES.find(item => item.id === "reported-exchange-move-6")
  assert.ok(openingFixture)
  assert.ok(annotateMoves(gameForCase(openingFixture)).every(move => move.outcome.redTurnsChecked === 1))
})

test("a historic forced-capture holdout is not mislabeled safe after a later Red promotion", () => {
  const fixture = CASES.find(item => item.id === "endgame-holdout-a")
  assert.ok(fixture)
  assert.equal(fixture.objective, "diagnostic")
  assert.equal(fixture.expectedMoveIds, null)
  const moves = annotateMoves(gameForCase(fixture))
  assert.ok(moves.every(move => move.outcome.worstNetAfterResponse < 0))
  const trade = moves.find(move => move.id === "f6-e5")
  assert.ok(trade)
  assert.equal(trade.outcome.minNextCaptureValue, 2)
  assert.equal(trade.outcome.worstNetAfterResponse, -1)
  assert.match(describeMove(trade), /Red a7-b8/)
})
