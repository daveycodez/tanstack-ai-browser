import assert from "node:assert/strict"
import { test } from "node:test"
import { annotatedLegalMoves, newGame, fromFen, applyMove } from "./chess.ts"
import { moveOutputSchema } from "./move-output.ts"
import { moveChoiceLabel, resolveActionLabel } from "./move-choice.ts"

test("structured output permits every exact action label in caller order and rejects unrelated forms", () => {
  const moves = annotatedLegalMoves(newGame("white"))
  const labels = moves.map(moveChoiceLabel)
  const schema = moveOutputSchema(labels)
  assert.deepEqual(schema.shape.move.options, labels)
  for (const move of moves) {
    const label = moveChoiceLabel(move)
    assert.deepEqual(schema.parse({ move: label }), { move: label })
    assert.equal(resolveActionLabel(moves, label), move.id)
    assert.throws(
      () => resolveActionLabel(moves, ` ${label}`),
      /noncanonical or illegal action/
    )
  }
  for (const value of [
    { move: "e4" },
    { move: "e2e4" },
    { move: "Move pawn e2 to e4", reason: "because" },
    { moveId: labels[0] },
    {}
  ])
    assert.equal(schema.safeParse(value).success, false)
  assert.throws(() => moveOutputSchema([]))
  assert.throws(() => moveOutputSchema([labels[0], labels[0]]), /unique/)
  assert.throws(
    () => resolveActionLabel([moves[0], moves[0]], labels[0]),
    /unique/
  )
})

test("action labels preserve castling, all promotions, en passant and origin disambiguation without check or safety labels", () => {
  const fixtures = [
    fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"),
    fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 1"),
    fromFen("1n3n1k/8/8/8/8/8/P7/K7 b - - 0 1"),
    fromFen("3r3k/8/8/3pP3/8/8/8/7K w - d6 0 1"),
    ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame("white"))
  ]
  const labels: string[] = []
  for (const game of fixtures) {
    const moves = annotatedLegalMoves(game)
    const schema = moveOutputSchema(moves.map(moveChoiceLabel))
    assert.equal(new Set(moves.map(moveChoiceLabel)).size, moves.length)
    for (const move of moves) {
      const label = moveChoiceLabel(move)
      labels.push(label)
      assert.equal(schema.safeParse({ move: label }).success, true)
      assert.equal(resolveActionLabel(moves, label), move.id)
      assert.doesNotMatch(
        label,
        /[+#]|\b(?:safe|danger|best|worst|checkmate|check)\b/i
      )
    }
  }
  for (const label of [
    "Castle kingside: king e8 to g8",
    "Castle queenside: king e8 to c8",
    "Move knight b8 to d7",
    "Move knight f8 to d7",
    "Move queen d8 to h4",
    "Capture pawn (1): pawn e5 to d6; en passant pawn on d5"
  ])
    assert.ok(labels.includes(label))
  for (const piece of ["queen", "rook", "bishop", "knight"])
    assert.ok(
      labels.some(
        (label) => label === `Move pawn a7 to a8; promote to ${piece}`
      )
    )
})

test("the simple opening bishop capture is an explicit Capture choice alongside every ordinary opening move", () => {
  const game = ["e2e4", "d7d5", "e4d5", "d8d7", "f1a6"].reduce(
    applyMove,
    newGame("white")
  )
  const moves = annotatedLegalMoves(game)
  const capture = moves.find((move) => move.id === "b7a6")
  assert.ok(capture)
  assert.equal(moveChoiceLabel(capture), "Capture bishop (3): pawn b7 to a6")
  assert.equal(resolveActionLabel(moves, moveChoiceLabel(capture)), "b7a6")
  assert.equal(
    moveOutputSchema(moves.map(moveChoiceLabel)).shape.move.options.length,
    moves.length
  )
})
