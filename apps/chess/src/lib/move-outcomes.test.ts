import assert from "node:assert/strict"
import { test } from "node:test"
import {
  annotatedLegalMoves,
  applyMove,
  fromFen,
  legalMoves,
  newGame
} from "./chess.ts"
import type { Game } from "./chess.ts"

const index = (square: string) =>
  (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97
const sequence = (game: Game, moves: string[]) => moves.reduce(applyMove, game)
const annotated = (
  game: Game,
  id: string,
  options: { relationships?: boolean } = {}
) => {
  const move = annotatedLegalMoves(game, options).find(
    (candidate) => candidate.id === id
  )
  assert.ok(move, `Expected legal candidate ${id}`)
  return move
}

test("identifies Fool's Mate explicitly while retaining all legal choices", () => {
  const game = sequence(newGame(), ["f2f3", "e7e5", "g2g4"])
  const moves = annotatedLegalMoves(game)
  assert.deepEqual(
    moves.map((move) => move.id),
    legalMoves(game).map((move) => move.id)
  )
  assert.equal(moves.length, 30)
  assert.deepEqual(
    moves.filter((move) => move.outcome.checkmate).map((move) => move.id),
    ["d8h4"]
  )
  assert.deepEqual(annotated(game, "d8h4").outcome, {
    check: true,
    checkmate: true,
    stalemate: false,
    allowsMateInOne: false,
    recapture: { count: 0 }
  })
})

test("distinguishes check without mate and an actual stalemating candidate", () => {
  const check = annotated(sequence(newGame(), ["e2e4", "f7f6"]), "d1h5")
  assert.equal(check.piece, "q")
  assert.equal(check.outcome.check, true)
  assert.equal(check.outcome.checkmate, false)
  assert.equal(check.outcome.stalemate, false)
  const stalemate = annotated(fromFen("7k/5K2/8/5Q2/8/8/8/8 w - - 0 1"), "f5g6")
  assert.deepEqual(stalemate.outcome, {
    check: false,
    checkmate: false,
    stalemate: true,
    allowsMateInOne: false,
    drawReason: "Stalemate",
    recapture: { count: 0 }
  })
})

test("reports the captured piece and counts distinct legal recapturers by material value", () => {
  const move = annotated(
    fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1"),
    "d8d4"
  )
  assert.equal(move.piece, "q")
  assert.equal(move.captured, "r")
  assert.deepEqual(move.captures, [index("d4")])
  assert.deepEqual(move.outcome.recapture, {
    count: 3,
    lowest: { piece: "p", value: 1, square: index("e3") }
  })
})

test("excludes a pinned pawn that pseudo-attacks the destination", () => {
  const move = annotated(
    fromFen("3qr2k/8/8/8/3R4/4PN2/8/4K3 b - - 0 1"),
    "d8d4"
  )
  assert.deepEqual(move.outcome.recapture, {
    count: 1,
    lowest: { piece: "n", value: 3, square: index("f3") }
  })
})

test("ranks a legal king recapture last and represents its value as null", () => {
  const kingOnly = annotated(fromFen("r6k/8/8/8/8/8/P7/1K6 b - - 0 1"), "a8a2")
  assert.deepEqual(kingOnly.outcome.recapture, {
    count: 1,
    lowest: { piece: "k", value: null, square: index("b1") }
  })
  const bishopAndKing = annotated(
    fromFen("r6k/8/8/8/8/8/PK6/1B6 b - - 0 1"),
    "a8a2"
  )
  assert.deepEqual(bishopAndKing.outcome.recapture, {
    count: 2,
    lowest: { piece: "b", value: 3, square: index("b1") }
  })
})

test("uses the actual en passant capture square, then counts legal recaptures", () => {
  const move = annotated(fromFen("3r3k/8/8/3pP3/8/8/8/7K w - d6 0 1"), "e5d6")
  assert.equal(move.captured, "p")
  assert.deepEqual(move.captures, [index("d5")])
  assert.deepEqual(move.outcome.recapture, {
    count: 1,
    lowest: { piece: "r", value: 5, square: index("d8") }
  })
})

test("counts an en passant reply removing a quiet double-pushed pawn", () => {
  const move = annotated(fromFen("7k/3p4/8/4P3/8/8/8/7K b - - 0 1"), "d7d5")
  assert.equal(move.captured, undefined)
  assert.deepEqual(move.captures, [])
  assert.deepEqual(move.outcome.recapture, {
    count: 1,
    lowest: { piece: "p", value: 1, square: index("e5") }
  })
})

test("counts four capture promotion variants from one pawn as one recapturing piece", () => {
  const move = annotated(fromFen("7r/1P6/7k/8/8/8/8/R6K b - - 0 1"), "h8a8")
  assert.deepEqual(move.outcome.recapture, {
    count: 2,
    lowest: { piece: "p", value: 1, square: index("b7") }
  })
})

test("preserves each candidate promotion choice and assesses the promoted piece's recapture", () => {
  const game = fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 1")
  for (const piece of ["q", "r", "b", "n"]) {
    const move = annotated(game, `a7a8${piece}`)
    assert.equal(move.piece, "p")
    assert.equal(move.promotion, piece)
    assert.equal(move.promotes, true)
    assert.deepEqual(move.outcome.recapture, {
      count: 1,
      lowest: { piece: "r", value: 5, square: index("b8") }
    })
  }
  const draw = annotated(game, "a7b8n")
  assert.equal(draw.outcome.drawReason, "Insufficient material")
  assert.deepEqual(draw.outcome.recapture, { count: 0 })
})

test("retains repetition history while independently inspecting every candidate", () => {
  const game = sequence(newGame(), [
    "g1f3",
    "g8f6",
    "f3g1",
    "f6g8",
    "g1f3",
    "g8f6",
    "f3g1"
  ])
  const restored = JSON.parse(JSON.stringify(game)) as Game
  assert.equal(
    annotated(restored, "f6g8").outcome.drawReason,
    "Threefold repetition"
  )
  assert.equal(annotated(restored, "d7d6").outcome.drawReason, undefined)
  assert.equal(game.status, "playing")
})

test("reports the fifty-move draw but resets the clock for a pawn candidate", () => {
  const game = fromFen("7k/8/8/8/8/8/RP6/7K w - - 99 1")
  assert.equal(annotated(game, "a2a3").outcome.drawReason, "Fifty-move rule")
  assert.equal(annotated(game, "b2b3").outcome.drawReason, undefined)
})

test("does not mutate game state or leak speculative moves into later evaluations", () => {
  const game = sequence(newGame(), ["e2e4", "d7d5"])
  const before = JSON.stringify(game)
  const first = annotatedLegalMoves(game)
  assert.ok(first.every((move) => move.outcome.relationships === undefined))
  assert.deepEqual(annotatedLegalMoves(game, { relationships: false }), first)
  assert.equal(JSON.stringify(game), before)
  assert.deepEqual(annotatedLegalMoves(game), first)
  assert.equal(JSON.stringify(game), before)
  assert.equal(applyMove(game, "e4d5").history.length, 3)
  assert.deepEqual(
    annotatedLegalMoves(fromFen("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1")),
    []
  )
})

test("flags a legal opponent mate-in-one reply without selecting a defense", () => {
  const game = fromFen(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const moves = annotatedLegalMoves(game)
  assert.equal(
    moves.find((move) => move.id === "b7b6")?.outcome.allowsMateInOne,
    true
  )
  assert.equal(
    moves.find((move) => move.id === "d8e7")?.outcome.allowsMateInOne,
    false
  )
  assert.equal(
    moves.find((move) => move.id === "g7g6")?.outcome.allowsMateInOne,
    false
  )
  assert.deepEqual(
    moves.map((move) => move.id),
    legalMoves(game).map((move) => move.id)
  )
})

const relationships = (game: Game, id: string) => {
  const result = annotated(game, id, { relationships: true }).outcome
    .relationships
  assert.ok(result)
  return result
}

test("identifies a threatened queen escaping to an actually safe square", () => {
  const result = relationships(
    fromFen("7k/8/8/4p3/3Q4/8/8/7K w - - 0 1"),
    "d4d3"
  )
  assert.equal(result.movedPieceWasThreatened, true)
  assert.deepEqual(result.movedPieceThreatenedBy, [])
  assert.ok(
    result.resolvedThreats.some(
      (piece) =>
        piece.piece === "q" &&
        piece.fromSquare === index("d4") &&
        piece.square === index("d3")
    )
  )
})

test("reports blocking or capturing the attacker as resolving a threat to another piece", () => {
  const blocking = relationships(
    fromFen("4r2k/8/8/8/8/8/3BQ3/7K w - - 0 1"),
    "d2e3"
  )
  assert.ok(
    blocking.resolvedThreats.some(
      (piece) => piece.piece === "q" && piece.square === index("e2")
    )
  )
  assert.deepEqual(blocking.movedPieceThreatenedBy, [
    { piece: "r", square: index("e8") }
  ])
  const capture = relationships(
    fromFen("7k/8/4r3/8/2B5/8/4Q3/7K w - - 0 1"),
    "c4e6"
  )
  assert.ok(
    capture.resolvedThreats.some(
      (piece) => piece.piece === "q" && piece.square === index("e2")
    )
  )
})

test("does not call adding a defender a resolved threat", () => {
  const result = relationships(
    fromFen("3r3k/8/8/8/8/3Q4/8/3B3K w - - 0 1"),
    "d1e2"
  )
  assert.ok(
    !result.resolvedThreats.some((piece) => piece.square === index("d3"))
  )
})

test("reports a newly attacked queen and a new attacker on an existing target", () => {
  const result = relationships(
    fromFen("7k/8/8/3q4/8/8/8/KN6 w - - 0 1"),
    "b1c3"
  )
  assert.deepEqual(result.newThreats, [
    {
      target: { piece: "q", square: index("d5") },
      attackers: [{ piece: "n", square: index("c3") }]
    }
  ])
  const additional = relationships(
    fromFen("7k/8/8/3q4/4P3/8/8/KN6 w - - 0 1"),
    "b1c3"
  )
  const threat = additional.newThreats.find(
    (threat) => threat.target.square === index("d5")
  )
  assert.ok(threat)
  assert.deepEqual(
    threat.attackers.map((piece) => piece.square).sort((a, b) => a - b),
    [index("e4"), index("c3")].sort((a, b) => a - b)
  )
})

test("tracks moved attacker and promoted pawn identities without inventing new attacks", () => {
  const rook = relationships(fromFen("7k/8/8/q7/8/8/8/R6K w - - 0 1"), "a1a2")
  assert.ok(
    !rook.newThreats.some((threat) => threat.target.square === index("a5"))
  )
  const promotion = relationships(
    fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 1"),
    "a7a8q"
  )
  assert.ok(
    !promotion.newThreats.some((threat) => threat.target.square === index("b8"))
  )
  assert.deepEqual(promotion.movedPieceThreatenedBy, [
    { piece: "r", square: index("b8") }
  ])
})

test("maps the rook relocation during castling when a previous rook threat disappears", () => {
  const result = relationships(
    fromFen("1k5r/8/8/8/8/8/8/R3K2R w KQ - 0 1"),
    "e1g1"
  )
  assert.ok(
    result.resolvedThreats.some(
      (piece) =>
        piece.piece === "r" &&
        piece.fromSquare === index("h1") &&
        piece.square === index("f1")
    )
  )
})

test("excludes pinned pseudo-attackers in both hypothetical capture maps", () => {
  const enemyPinned = relationships(
    fromFen("4k3/4p3/3Q4/8/8/8/4R3/7K w - - 0 1"),
    "d6d5"
  )
  assert.equal(enemyPinned.movedPieceWasThreatened, false)
  assert.ok(
    !enemyPinned.resolvedThreats.some(
      (piece) => piece.fromSquare === index("d6")
    )
  )
  const ownPinned = relationships(
    fromFen("4r2k/8/8/8/8/3q4/4B3/1N2K3 w - - 0 1"),
    "b1c3"
  )
  assert.ok(
    !ownPinned.newThreats.some((threat) => threat.target.square === index("d3"))
  )
})

test("treats check separately and excludes synthetic king captures without throwing", () => {
  const checked = fromFen("4r2k/8/8/8/8/8/Q7/4K3 w - - 0 1")
  assert.equal(checked.inCheck, true)
  const escaped = relationships(checked, "e1d1")
  assert.equal(escaped.movedPieceWasThreatened, false)
  assert.ok(escaped.newThreats.every((threat) => threat.target.piece !== "k"))
  const check = annotated(sequence(newGame(), ["e2e4", "f7f6"]), "d1h5", {
    relationships: true
  })
  assert.equal(check.outcome.check, true)
  assert.ok(
    check.outcome.relationships?.newThreats.every(
      (threat) => threat.target.piece !== "k"
    )
  )
  const mate = annotated(
    sequence(newGame(), ["f2f3", "e7e5", "g2g4"]),
    "d8h4",
    { relationships: true }
  )
  assert.equal(mate.outcome.relationships, undefined)
})
