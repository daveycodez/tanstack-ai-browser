import assert from "node:assert/strict"
import { test } from "node:test"
import { annotatedLegalMoves, newGame, fromFen, applyMove } from "./chess.ts"
import { moveOutputSchema } from "./move-output.ts"
import { describeMoveChoice, moveChoiceLabel, resolveActionLabel } from "./move-choice.ts"

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
    { move: "not-a-move" },
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

test("action labels preserve castling, all promotions, en passant and origin disambiguation with readable descriptions and exact short labels", () => {
  const fixtures = [
    fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"),
    fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 1"),
    fromFen("1n3n1k/8/8/8/8/8/P7/K7 b - - 0 1"),
    fromFen("3r3k/8/8/3pP3/8/8/8/7K w - d6 0 1"),
    ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame("white"))
  ]
  const labels: string[] = []
  const descriptions: string[] = []
  for (const game of fixtures) {
    const moves = annotatedLegalMoves(game)
    const schema = moveOutputSchema(moves.map(moveChoiceLabel))
    assert.equal(new Set(moves.map(moveChoiceLabel)).size, moves.length)
    for (const move of moves) {
      const label = moveChoiceLabel(move)
      labels.push(label)
      descriptions.push(describeMoveChoice(move))
      assert.equal(schema.safeParse({ move: label }).success, true)
      assert.equal(resolveActionLabel(moves, label), move.id)
      assert.ok(label.endsWith(move.notation))
      assert.equal(resolveActionLabel(moves, label), move.id)
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
    assert.ok(descriptions.includes(label))
  for (const piece of ["queen", "rook", "bishop", "knight"])
    assert.ok(
      descriptions.some(
        (label) => label === `Move pawn a7 to a8; promote to ${piece}`
      )
    )
})

test("the simple opening bishop capture is an explicit Capture choice alongside every ordinary opening move", () => {
  const game = ["e2e4", "d7d5", "e4d5", "d8d7", "f1a6"].reduce(
    applyMove,
    newGame("white")
  )
  const moves = annotatedLegalMoves(game, { safety: true })
  const capture = moves.find((move) => move.id === "b7a6")
  assert.ok(capture)
  assert.equal(moveChoiceLabel(capture), "bxa6")
  assert.equal(describeMoveChoice(capture), "Capture bishop (3): pawn b7 to a6")
  assert.equal(resolveActionLabel(moves, moveChoiceLabel(capture)), "b7a6")
  assert.equal(
    moveOutputSchema(moves.map(moveChoiceLabel)).shape.move.options.length,
    moves.length
  )
})


test("computed losing exchanges remain selectable and compensated exchanges are not labeled as losses", () => {
  const moves = annotatedLegalMoves(fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 40"), { safety: true, relationships: true })
  const capture = moves.find(move => move.id === "d8d4")
  assert.ok(capture)
  const label = moveChoiceLabel(capture)
  assert.equal(label, "RISK -4: Qxd4")
  const schema = moveOutputSchema(moves.map(moveChoiceLabel))
  assert.deepEqual(schema.parse({ move: label }), { move: label })
  assert.equal(schema.shape.move.options.length, moves.length)
  assert.equal(resolveActionLabel(moves, label), "d8d4")
  assert.equal(schema.safeParse({ move: "Qxd4" }).success, false)
  const balanced = annotatedLegalMoves(fromFen("3q3k/6p1/8/8/8/5Q2/8/7K b - - 0 40"), { safety: true, relationships: true }).find(move => move.id === "d8f6")
  assert.ok(balanced)
  assert.equal(moveChoiceLabel(balanced), "Qf6")
  const mateReplies = annotatedLegalMoves(fromFen("r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"), { safety: true })
  const allowsMate = mateReplies.find(move => move.id === "g8f6")
  assert.ok(allowsMate?.outcome.allowsMateInOne)
  const mateLabel = moveChoiceLabel(allowsMate)
  assert.equal(mateLabel, "RISK -1: Nf6")
  assert.equal(resolveActionLabel(mateReplies, mateLabel), "g8f6")
  assert.equal(moveOutputSchema(mateReplies.map(moveChoiceLabel)).safeParse({ move: mateLabel }).success, true)
})
