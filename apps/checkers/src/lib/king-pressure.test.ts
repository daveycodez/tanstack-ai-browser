import assert from "node:assert/strict"
import test from "node:test"
import { CASES, gameForCase } from "../../bench/cases.ts"
import { acceptedChoices, inspectChoices } from "../../bench/audit.ts"
import { applyMove, legalMoves } from "./checkers.ts"
import { annotateMoves, describeMove } from "./move-outcomes.ts"

function fixture(id: string) {
  const found = CASES.find(item => item.id === id)
  assert.ok(found, `Missing ${id}`)
  return found
}
const sameSquares = (a: readonly number[], b: readonly number[]) => assert.deepEqual([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y))

for (const testCase of CASES) {
  test(`capture opportunities and king escapes match independent replies: ${testCase.id}`, () => {
    const game = gameForCase(testCase)
    const reference = inspectChoices(game)
    for (const move of annotateMoves(game)) {
      const expected = reference.find(choice => choice.id === move.id)
      assert.ok(expected)
      const facts = move.outcome
      assert.equal(facts.minNextCaptureValue, expected.minNextCaptureValue)
      assert.equal(facts.captureFreeRedReplies, expected.captureFreeRedReplies)
      assert.deepEqual(facts.redKingEscapes, expected.redKingEscapes)
      sameSquares(facts.forcedKingCaptureTargets, expected.forcedKingCaptureTargets)
      for (const reply of facts.redReplies) {
        const red = expected.replies.find(item => item.id === reply.id)
        assert.ok(red)
        assert.equal(reply.nextCaptureValue, red.nextCaptureValue)
        sameSquares(reply.capturableRedKings, red.capturableRedKings)
        if (reply.status !== "playing") {
          assert.equal(reply.nextCaptureValue, 0, "terminal replies do not invent a Black continuation")
          assert.deepEqual(reply.capturableRedKings, [])
        }
      }
      if (facts.forcedKingCaptureTargets.length) {
        assert.ok(facts.redReplies.length > 0)
        for (const square of facts.forcedKingCaptureTargets) assert.ok(facts.redReplies.every(reply => reply.status === "playing" && reply.capturableRedKings.includes(square)))
      }
    }
  })
}

test("endgame grades preserve every strongest guaranteed-capture tie and never replace an immediate win", () => {
  const cases = CASES.filter(item => item.id.startsWith("endgame-"))
  assert.equal(cases.length, 8)
  assert.equal(cases.filter(item => item.partition === "holdout").length, 2)
  assert.equal(cases.filter(item => item.expectedMoveIds !== null).length, 6)
  for (const testCase of cases) {
    const game = gameForCase(testCase)
    const black = game.board.filter(piece => piece?.side === "ai")
    const red = game.board.filter(piece => piece?.side === "human")
    assert.ok(black.length >= 2 && black.length <= 3 && black.every(piece => piece?.king))
    assert.equal(red.filter(piece => piece?.king).length, 1)
    assert.ok(red.length <= 2)
    const choices = inspectChoices(game)
    assert.ok(choices.length > 1)
    assert.ok(choices.every(choice => choice.status !== "ai-won" && choice.captures === 0))
    if (testCase.objective === "force-next-capture") {
      assert.deepEqual(acceptedChoices(game, testCase.objective)?.sort(), [...testCase.expectedMoveIds ?? []].sort())
      assert.ok(choices.filter(choice => testCase.expectedMoveIds?.includes(choice.id)).every(choice => choice.minNextCaptureValue > 0 && choice.worstNet >= 0))
    }
  }
  assert.deepEqual(acceptedChoices(gameForCase(fixture("endgame-two-kings-force-king")), "force-next-capture"), ["b2-c3", "b2-c1"], "both advancing and waiting alternatives can preserve a capture net")
})

test("a moving Red king is tracked by identity through the complete reply and Black multi-jump", () => {
  const game = gameForCase(fixture("endgame-force-king-over-man"))
  const choice = annotateMoves(game).find(move => move.id === "d2-c3")
  assert.ok(choice)
  assert.equal(choice.outcome.minNextCaptureValue, 3)
  assert.deepEqual(choice.outcome.forcedKingCaptureTargets, [7], "the original Red king is h8")
  const reply = choice.outcome.redReplies.find(item => item.id === "h8xf6")
  assert.ok(reply)
  assert.equal(reply.nextCaptureValue, 3)
  assert.deepEqual(reply.capturableRedKings, [7], "identity remains h8 after the king lands on f6")
  const after = applyMove(applyMove(game, choice.id), reply.id)
  const chain = legalMoves(after.board, "ai").find(move => move.id === "c3xe5xg7")
  assert.ok(chain)
  assert.equal(chain.captures.length, 2)
  assert.equal(chain.captures.reduce((sum, square) => sum + (after.board[square]?.king ? 2 : 1), 0), 3)
})

test("fewer Red replies alone does not justify hanging a Black king", () => {
  const testCase = fixture("endgame-pressure-negative-control")
  assert.equal(testCase.expectedMoveIds, null)
  const game = gameForCase(testCase)
  const choices = annotateMoves(game)
  const bad = choices.find(move => move.id === "c7-d6")
  const waiting = choices.find(move => move.id === "a7-b6")
  assert.ok(bad && waiting)
  assert.equal(bad.outcome.redReplies.length, 1)
  assert.ok(waiting.outcome.redReplies.length > bad.outcome.redReplies.length)
  assert.equal(bad.outcome.redReplies[0].id, "e5xc7")
  assert.equal(bad.outcome.worstNetAfterResponse, -2)
  assert.equal(bad.outcome.minNextCaptureValue, 0)
  assert.equal(bad.outcome.redKingEscapes[0].safeReplies, 1)
  assert.equal(waiting.outcome.worstNetAfterResponse, 0)
  assert.deepEqual(bad.outcome.forcedKingCaptureTargets, [])
})

test("quiet pressure and undoing history remain ungraded observations", () => {
  const testCase = fixture("endgame-reversal-diagnostic")
  assert.equal(testCase.expectedMoveIds, null)
  const game = gameForCase(testCase)
  assert.equal(game.history.length, 2)
  const choices = annotateMoves(game)
  const undo = choices.find(move => move.id === "c1-b2")
  const pressure = choices.find(move => move.id === "d4-c5")
  assert.ok(undo && pressure)
  assert.equal(undo.outcome.reversesLastOwnMove, true)
  assert.equal(pressure.outcome.reversesLastOwnMove, false)
  assert.equal(undo.outcome.worstNetAfterResponse, 0)
  assert.equal(pressure.outcome.worstNetAfterResponse, 0)
  assert.equal(undo.outcome.redKingEscapes[0].safeReplies, 2)
  assert.equal(pressure.outcome.redKingEscapes[0].safeReplies, 1)
  assert.equal(pressure.outcome.minNextCaptureValue, 0, "partial pressure is not a forced capture")
  assert.match(describeMove(pressure), /Red king safe replies: a7 1\/2/)
})

test("a two-king material majority does not itself claim a forced win or capture", () => {
  const game = gameForCase({ id: "majority-negative-control", label: "", description: "", objective: "diagnostic", partition: "calibration", setup: { black: ["a1K", "c1K"], red: ["d4K"] }, expectedMoveIds: null })
  const choices = annotateMoves(game)
  assert.ok(choices.every(move => move.outcome.status === "playing" && !move.outcome.forcesWinNextTurn && move.outcome.minNextCaptureValue === 0 && move.outcome.forcedKingCaptureTargets.length === 0))
})
