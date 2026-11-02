import assert from "node:assert/strict"
import { test } from "node:test"
import { Chess } from "chess.js"
import {
  annotatedLegalMoves,
  applyMove,
  currentThreats,
  fromFen,
  legalMoves,
  newGame
} from "./chess.ts"
import type { Game, MoveContextOptions } from "./chess.ts"

const index = (square: string) =>
  (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97
const sequence = (game: Game, moves: string[]) => moves.reduce(applyMove, game)
const annotated = (
  game: Game,
  id: string,
  options: MoveContextOptions = {}
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

test("keeps every context group independently opt-in with default core facts unchanged", () => {
  const game = applyMove(newGame(), "e2e4")
  const baseline = annotated(game, "e7e5")
  const names = ["relationships", "support", "mobility", "castling"] as const
  for (const name of names) {
    assert.equal(baseline.outcome[name], undefined)
    const expanded = annotated(game, "e7e5", { [name]: true })
    assert.ok(expanded.outcome[name])
    for (const other of names)
      if (other !== name) assert.equal(expanded.outcome[other], undefined)
    const core = { ...expanded, outcome: { ...expanded.outcome } }
    delete core.outcome[name]
    assert.deepEqual(core, baseline)
  }
})

test("distinguishes geometric support from an exact legal recapture and capture immunity", () => {
  const game = fromFen("7k/8/8/4p3/8/2BQ4/8/7K w - - 0 1")
  const move = annotated(game, "d3d4", { support: true, relationships: true })
  assert.equal(move.outcome.recapture.count, 1)
  assert.deepEqual(move.outcome.relationships?.movedPieceThreatenedBy, [
    { piece: "p", square: index("e5") }
  ])
  assert.deepEqual(move.outcome.support?.movedPieceGeometricDefenders, [
    { piece: "b", square: index("c3") }
  ])
  assert.deepEqual(move.outcome.support?.conditionalRecaptures, [
    {
      captureId: "e5d4",
      attacker: { piece: "p", square: index("d4") },
      defenders: [{ piece: "b", square: index("c3") }]
    }
  ])
})

test("excludes pinned geometric defenders and pinned legal recapturers", () => {
  const move = annotated(
    fromFen("4r2k/8/8/8/8/2pQ4/4R3/4K3 w - - 0 1"),
    "d3d2",
    { support: true }
  )
  assert.ok(move.outcome.support)
  assert.ok(
    !move.outcome.support.movedPieceGeometricDefenders.some(
      (piece) => piece.square === index("e2")
    )
  )
  const capture = move.outcome.support.conditionalRecaptures.find(
    (capture) => capture.captureId === "c3d2"
  )
  assert.ok(capture)
  assert.ok(!capture.defenders.some((piece) => piece.square === index("e2")))
})

test("adds support to an attacked friendly queen without claiming its threat disappeared", () => {
  const move = annotated(fromFen("3r3k/8/8/8/8/3Q4/8/3B3K w - - 0 1"), "d1e2", {
    support: true,
    relationships: true
  })
  assert.deepEqual(move.outcome.support?.addedFriendlySupport, [
    {
      target: { piece: "q", square: index("d3") },
      supporters: [{ piece: "b", square: index("e2") }],
      beforeCount: 0,
      afterCount: 1,
      wasThreatened: true
    }
  ])
  assert.ok(
    !move.outcome.relationships?.resolvedThreats.some(
      (piece) => piece.square === index("d3")
    )
  )
  const after = applyMove(fromFen("3r3k/8/8/8/8/3Q4/8/3B3K w - - 0 1"), "d1e2")
  assert.ok(legalMoves(after).some((move) => move.id === "d8d3"))
})

test("describes a two-square opening pawn move and newly mobile bishop and queen neutrally", () => {
  const move = annotated(applyMove(newGame(), "e2e4"), "e7e5", {
    mobility: true
  })
  assert.deepEqual(move.outcome.mobility?.pawnAdvance, {
    squares: 2,
    centralSquaresControlled: [index("d4")]
  })
  const bishop = move.outcome.mobility?.changedOtherPieces.find(
    (piece) => piece.square === index("f8")
  )
  const queen = move.outcome.mobility?.changedOtherPieces.find(
    (piece) => piece.square === index("d8")
  )
  assert.equal(bishop?.before, 0)
  assert.equal(bishop?.after, 5)
  assert.equal(queen?.before, 0)
  assert.equal(queen?.after, 4)
  assert.ok(
    !move.outcome.mobility?.changedOtherPieces.some(
      (piece) => piece.fromSquare === index("e7")
    )
  )
  const single = annotated(applyMove(newGame(), "e2e4"), "e7e6", {
    mobility: true
  })
  assert.equal(single.outcome.mobility?.pawnAdvance?.squares, 1)
})

test("tracks minor-piece home moves without calling a defended but blocked queen mobile", () => {
  const move = annotated(applyMove(newGame(), "e2e4"), "g8f6", {
    mobility: true,
    support: true
  })
  assert.equal(move.outcome.mobility?.leavesMinorHomeSquare, true)
  assert.equal(move.outcome.mobility?.pawnAdvance, undefined)
  assert.ok(
    !move.outcome.mobility?.changedOtherPieces.some(
      (piece) => piece.square === index("d8")
    )
  )
})

test("records permanent king and rook castling-right losses and captured enemy rook rights", () => {
  const game = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
  const king = annotated(game, "e1e2", { castling: true })
  assert.deepEqual(king.outcome.castling?.lostRights, [
    { side: "human", wing: "kingside" },
    { side: "human", wing: "queenside" }
  ])
  const rook = annotated(game, "h1h2", { castling: true })
  assert.deepEqual(rook.outcome.castling?.lostRights, [
    { side: "human", wing: "kingside" }
  ])
  const capture = annotated(game, "h1h8", { castling: true })
  assert.deepEqual(capture.outcome.castling?.lostRights, [
    { side: "human", wing: "kingside" },
    { side: "ai", wing: "kingside" }
  ])
  const returned = sequence(game, ["h1h2", "h8h7", "h2h1", "h7h8"])
  const next = annotated(returned, "a1a2", { castling: true })
  assert.ok(
    !next.outcome.castling?.paths.some(
      (path) => path.side === "human" && path.wing === "kingside"
    )
  )
})

test("identifies actual castling separately from sacrificing unused castling rights", () => {
  const game = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
  for (const [id, wing] of [
    ["e1g1", "kingside"],
    ["e1c1", "queenside"]
  ]) {
    const move = annotated(game, id, { castling: true })
    assert.equal(move.outcome.castling?.performed, wing)
    assert.deepEqual(move.outcome.castling?.lostRights, [])
  }
})

test("distinguishes clearing a castle blocker from legally available castling", () => {
  const cleared = annotated(
    fromFen("r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1"),
    "f1e2",
    { castling: true }
  )
  const path = cleared.outcome.castling?.paths.find(
    (path) => path.side === "human" && path.wing === "kingside"
  )
  assert.deepEqual(path?.clearedSquares, [index("f1")])
  assert.equal(path?.pathClear, true)
  assert.equal(path?.rightAfter, true)
  assert.equal(path?.legalNow, true)
  const blocked = annotated(
    fromFen("r3k2r/8/8/8/8/8/8/R3KBNR w KQkq - 0 1"),
    "g1f3",
    { castling: true }
  )
  const blockedPath = blocked.outcome.castling?.paths.find(
    (path) => path.side === "human" && path.wing === "kingside"
  )
  assert.deepEqual(blockedPath?.clearedSquares, [index("g1")])
  assert.equal(blockedPath?.pathClear, false)
  assert.equal(blockedPath?.legalNow, false)
})

test("never labels an empty castling path legal through an attacked square or while in check", () => {
  const throughCheck = annotated(
    fromFen("r3kr1r/8/8/8/8/8/P7/R3K2R w KQkq - 0 1"),
    "a2a3",
    { castling: true }
  )
  const path = throughCheck.outcome.castling?.paths.find(
    (path) => path.side === "human" && path.wing === "kingside"
  )
  assert.equal(path?.pathClear, true)
  assert.equal(path?.rightAfter, true)
  assert.equal(path?.legalNow, false)
  const inCheck = annotated(
    fromFen("1k3r2/8/8/8/8/8/8/R3K2R b KQ - 0 1"),
    "f8e8",
    { castling: true }
  )
  const checkedPath = inCheck.outcome.castling?.paths.find(
    (path) => path.side === "human" && path.wing === "kingside"
  )
  assert.equal(inCheck.outcome.check, true)
  assert.equal(checkedPath?.pathClear, true)
  assert.equal(checkedPath?.legalNow, false)
})

test("all context groups preserve game/history and repeated annotations", () => {
  const game = sequence(newGame(), ["e2e4", "d7d5"])
  const before = JSON.stringify(game)
  const options = {
    relationships: true,
    support: true,
    mobility: true,
    castling: true
  }
  const first = annotatedLegalMoves(game, options)
  assert.equal(JSON.stringify(game), before)
  assert.deepEqual(annotatedLegalMoves(game, options), first)
  assert.equal(JSON.stringify(game), before)
  assert.deepEqual(
    first.map((move) => move.id),
    legalMoves(game).map((move) => move.id)
  )
})

test("reports a current pawn threat to the queen even when a different piece might move", () => {
  const game = fromFen("7k/8/8/8/3q4/2P5/8/7K b - - 0 1")
  assert.deepEqual(currentThreats(game), [
    {
      target: { piece: "q", square: index("d4") },
      attackers: [{ piece: "p", square: index("c3") }]
    }
  ])
})

test("reports all distinct current attackers, deduplicating capture-promotion variants", () => {
  const threats = currentThreats(fromFen("7k/8/8/8/3q4/2B1PN2/8/7K b - - 0 1"))
  assert.equal(threats.length, 1)
  assert.equal(threats[0]?.attackers.length, 3)
  assert.deepEqual(
    new Set(threats[0]?.attackers.map((piece) => piece.square)),
    new Set([index("c3"), index("e3"), index("f3")])
  )
  assert.deepEqual(currentThreats(fromFen("r6k/1P6/8/8/8/8/8/7K b - - 0 1")), [
    {
      target: { piece: "r", square: index("a8") },
      attackers: [{ piece: "p", square: index("b7") }]
    }
  ])
})

test("excludes current pinned pawn captures and keeps king checks separate", () => {
  const pinned = fromFen("4r2k/8/8/8/3q4/4P3/8/4K3 b - - 0 1")
  assert.ok(
    !currentThreats(pinned).some(
      (threat) => threat.target.square === index("d4")
    )
  )
  const checked = fromFen("4r2k/8/8/8/8/8/Q7/4K3 w - - 0 1")
  assert.equal(checked.inCheck, true)
  assert.ok(
    currentThreats(checked).every((threat) => threat.target.piece !== "k")
  )
})

test("clears en passant on the hypothetical opposite turn and preserves game state", () => {
  const game = fromFen("7k/8/8/8/3pP3/8/5P2/7K b - e3 0 1")
  const before = JSON.stringify(game)
  assert.deepEqual(currentThreats(game), [])
  assert.equal(JSON.stringify(game), before)
  assert.deepEqual(currentThreats(game), [])
  assert.deepEqual(currentThreats(fromFen("7k/8/8/8/8/8/8/7K w - - 0 1")), [])
})

test("reply major-loss facts are opt-in, include terminal empty arrays, and do not filter moves", () => {
  const game = sequence(newGame(), ["f2f3", "e7e5", "g2g4"])
  assert.equal(annotated(game, "d8h4").outcome.replyMajorLosses, undefined)
  const moves = annotatedLegalMoves(game, { safety: true })
  assert.deepEqual(
    moves.map((move) => move.id),
    legalMoves(game).map((move) => move.id)
  )
  assert.deepEqual(
    moves.find((move) => move.id === "d8h4")?.outcome.replyMajorLosses,
    []
  )
})

test("allows an actually defended queen trade while identifying an undefended queen sacrifice", () => {
  const trade = annotated(
    fromFen("3q3k/6p1/8/8/8/5Q2/8/7K b - - 0 40"),
    "d8f6",
    { safety: true }
  )
  assert.equal(trade.outcome.recapture.count, 1)
  assert.deepEqual(trade.outcome.replyMajorLosses, [])
  const scholar = fromFen(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const hanging = annotated(scholar, "d8h4", { safety: true })
  assert.ok(
    hanging.outcome.replyMajorLosses?.some(
      (loss) => loss.piece === "q" && loss.netMaterial === -9
    )
  )
})

test("reports an unmoved queen lost after an unrelated king move", () => {
  const game = fromFen("7k/8/8/8/3q4/2P5/8/7K b - - 0 40")
  const move = annotated(game, "h8g8", { safety: true })
  assert.deepEqual(move.outcome.replyMajorLosses, [
    {
      piece: "q",
      square: index("d4"),
      capturedBy: { piece: "p", square: index("c3") },
      netMaterial: -9
    }
  ])
})

test("counts only legal immediate material recaptures, excluding a pinned pawn", () => {
  const pinned = annotated(
    fromFen("3qk3/8/8/4p3/8/2Q5/8/4R2K b - - 0 40"),
    "d8d4",
    { safety: true }
  )
  assert.equal(pinned.outcome.replyMajorLosses?.[0]?.netMaterial, -9)
  const unpinned = annotated(
    fromFen("3q3k/8/8/4p3/8/2Q5/8/4R2K b - - 0 40"),
    "d8d4",
    { safety: true }
  )
  assert.deepEqual(unpinned.outcome.replyMajorLosses, [])
})

test("includes candidate material compensation instead of labeling every major capture a loss", () => {
  const queenForRook = annotated(
    fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 40"),
    "d8d4",
    { safety: true }
  )
  assert.equal(queenForRook.outcome.replyMajorLosses?.length, 3)
  assert.ok(
    queenForRook.outcome.replyMajorLosses?.every(
      (loss) => loss.netMaterial === -4
    )
  )
  const rookForQueen = annotated(
    fromFen("r5k1/5p2/8/8/8/8/Q6R/7K b - - 0 40"),
    "a8a2",
    { safety: true }
  )
  assert.equal(rookForQueen.outcome.recapture.count, 1)
  assert.deepEqual(rookForQueen.outcome.replyMajorLosses, [])
})

test("accounts for promotion gains of the candidate and the capturing opponent", () => {
  const ownPromotion = annotated(
    fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 40"),
    "a7a8q",
    { safety: true }
  )
  assert.equal(ownPromotion.outcome.replyMajorLosses?.[0]?.netMaterial, -1)
  const opposing = annotated(
    fromFen("1r5k/1P6/8/8/8/8/8/7K b - - 0 40"),
    "b8a8",
    { safety: true }
  )
  assert.deepEqual(
    opposing.outcome.replyMajorLosses
      ?.map((loss) => loss.netMaterial)
      .sort((a, b) => a - b),
    [-13, -9, -7, -7]
  )
  const recaptured = annotated(
    fromFen("1rr4k/1P6/8/8/8/8/8/7K b - - 0 40"),
    "b8a8",
    { safety: true }
  )
  assert.ok(
    recaptured.outcome.replyMajorLosses
      ?.filter((loss) => loss.square === index("a8"))
      .every((loss) => loss.netMaterial === -4)
  )
})

test("includes the best legal recapturing pawn promotion material gain", () => {
  const game = fromFen("R7/7k/8/8/8/8/1p6/2q3NK b - - 0 40")
  const move = annotated(game, "c1a1", { safety: true })
  assert.deepEqual(move.outcome.replyMajorLosses, [])
  // Independent fresh-board leaf verification: Q-a1, Rxa1, bxa1=Q yields +4.
  const engine = new Chess(game.fen)
  const value = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
  const balance = (position: Chess) =>
    position
      .board()
      .flat()
      .reduce(
        (sum, piece) =>
          sum +
          (piece ? (piece.color === "b" ? 1 : -1) * value[piece.type] : 0),
        0
      )
  const before = balance(engine)
  engine.move({ from: "c1", to: "a1" })
  engine.move({ from: "a8", to: "a1" })
  engine.move({ from: "b2", to: "a1", promotion: "q" })
  assert.equal(balance(engine) - before, 4)
})

test("positive mate-defense safety agrees with all six audited casual defenses", () => {
  const fen =
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  const annotatedMoves = annotatedLegalMoves(fromFen(fen), { safety: true })
  const safe = annotatedMoves
    .filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMajorLosses?.length === 0
    )
    .map((move) => move.id)
  assert.deepEqual(
    new Set(safe),
    new Set(["d8e7", "d8f6", "e8e7", "g8h6", "d7d5", "g7g6"])
  )
  // Independently traverse every White reply; none of these candidates permits mate.
  for (const id of safe) {
    const engine = new Chess(fen)
    engine.move({ from: id.slice(0, 2), to: id.slice(2, 4) })
    for (const reply of engine.moves({ verbose: true }))
      assert.equal(new Chess(reply.after).isCheckmate(), false)
  }
})

test("speculative reply-capture analysis preserves history and every other context group", () => {
  const game = fromFen("3q3k/6p1/8/8/8/5Q2/8/7K b - - 0 40")
  const options = {
    relationships: true,
    support: true,
    mobility: true,
    castling: true,
    safety: true
  }
  const before = JSON.stringify(game)
  const first = annotatedLegalMoves(game, options)
  assert.equal(JSON.stringify(game), before)
  assert.deepEqual(annotatedLegalMoves(game, options), first)
  const withoutSafety = annotatedLegalMoves(game, { ...options, safety: false })
  assert.deepEqual(
    first.map((move) => {
      const copy = { ...move, outcome: { ...move.outcome } }
      delete copy.outcome.replyMajorLosses
      delete copy.outcome.replyMaterialLosses
      return copy
    }),
    withoutSafety
  )
})

test("king-cover facts are opt-in and preserve all moves and the saved game", () => {
  const game = sequence(newGame(), ["e2e4"])
  const saved = JSON.stringify(game)
  const baseline = annotatedLegalMoves(game)
  assert.ok(baseline.every((move) => move.outcome.kingCover === undefined))
  const withCover = annotatedLegalMoves(game, { kingCover: true })
  assert.deepEqual(
    withCover.map((move) => move.id),
    baseline.map((move) => move.id)
  )
  assert.equal(JSON.stringify(game), saved)
  const central = withCover.find((move) => move.id === "e7e6")
  assert.ok(central?.outcome.kingCover)
  assert.deepEqual(
    central.outcome.kingCover.before,
    central.outcome.kingCover.after
  )
  assert.deepEqual(central.outcome.kingCover.relevantWings, [])
})

test("current wing cover survives absent castling rights and reports neutral pawn distances", () => {
  const game = fromFen("6k1/5ppp/8/8/8/8/8/4K3 b - - 0 40")
  for (const id of ["g7g6", "h7h6"]) {
    const cover = annotated(game, id, { kingCover: true }).outcome.kingCover
    assert.ok(cover)
    assert.equal(cover.before[0].kind, "current")
    assert.deepEqual(cover.before[0].homeFiles, ["f", "g", "h"])
    assert.deepEqual(cover.after[0].nearFiles, ["f", "g", "h"])
    assert.deepEqual(cover.after[0].missingFiles, [])
    assert.deepEqual(cover.relevantWings, ["kingside"])
  }
  const advanced = annotated(game, "g7g5", { kingCover: true }).outcome
    .kingCover
  assert.ok(advanced)
  assert.deepEqual(advanced.after[0].nearFiles, ["f", "h"])
  assert.deepEqual(advanced.after[0].advancedFiles, ["g"])
  assert.deepEqual(advanced.after[0].missingFiles, [])
  const both = sequence(game, ["g7g5", "e1e2"])
  const h6 = annotated(both, "h7h6", { kingCover: true }).outcome.kingCover
  assert.deepEqual(h6?.after[0].nearFiles, ["f", "h"])
  const h8 = annotated(game, "g8h8", { kingCover: true }).outcome.kingCover
  assert.equal(h8?.after[0].kind, "current")
  assert.equal(h8?.after[0].kingSquare, index("h8"))
})

test("cover counts unique files, actual pawn squares, and missing files independently", () => {
  const move = annotated(
    fromFen("6k1/5p1p/6p1/6p1/8/8/8/4K3 b - - 0 40"),
    "h7h6",
    { kingCover: true }
  )
  const profile = move.outcome.kingCover?.after[0]
  assert.ok(profile)
  assert.equal(profile.pawnSquares.length, 4)
  assert.deepEqual(profile.nearFiles, ["f", "g", "h"])
  assert.deepEqual(profile.advancedFiles, [])
  const missing = annotated(
    fromFen("6k1/5p1p/8/8/8/8/8/4K3 b - - 0 40"),
    "h7h6",
    { kingCover: true }
  )
  assert.deepEqual(missing.outcome.kingCover?.after[0].missingFiles, ["g"])
})

test("future castle cover depends on permanent rights, not temporary blockers or check", () => {
  const game = fromFen("r3kb1r/ppp2ppp/8/8/8/8/8/4R1K1 b kq - 0 40")
  const block = annotated(game, "f8e7", { kingCover: true, castling: true })
  assert.deepEqual(
    block.outcome.kingCover?.before.map((profile) => [
      profile.kind,
      profile.wing
    ]),
    [
      ["future", "kingside"],
      ["future", "queenside"]
    ]
  )
  assert.deepEqual(
    block.outcome.kingCover?.before,
    block.outcome.kingCover?.after
  )
  const rook = annotated(
    fromFen("r3k2r/ppp2ppp/8/8/8/8/8/4K3 b kq - 0 40"),
    "h8g8",
    { kingCover: true, castling: true }
  )
  assert.deepEqual(
    rook.outcome.kingCover?.after.map((profile) => profile.wing),
    ["queenside"]
  )
  assert.ok(
    !rook.outcome.castling?.paths.some(
      (path) => path.side === "ai" && path.wing === "kingside"
    )
  )
  const noRights = annotated(
    fromFen("r3k2r/ppp2ppp/8/8/8/8/8/4K3 b - - 0 40"),
    "g7g5",
    { kingCover: true, castling: true }
  )
  assert.deepEqual(noRights.outcome.kingCover, {
    before: [],
    after: [],
    relevantWings: []
  })
  assert.deepEqual(noRights.outcome.castling?.lostRights, [])
  assert.deepEqual(noRights.outcome.castling?.paths, [])
})

test("actual castling has landing cover and no duplicate future loss/path story", () => {
  const game = fromFen("r3k2r/ppp2ppp/8/8/8/8/8/4K3 b kq - 0 40")
  for (const id of ["e8g8", "e8c8"]) {
    const move = annotated(game, id, { kingCover: true, castling: true })
    assert.equal(move.outcome.kingCover?.landing?.kind, "current")
    assert.equal(
      move.outcome.kingCover?.landing?.wing,
      move.outcome.castling?.performed
    )
    assert.deepEqual(
      move.outcome.kingCover?.landing?.nearFiles,
      id === "e8g8" ? ["f", "g", "h"] : ["a", "b", "c"]
    )
    assert.deepEqual(move.outcome.castling?.lostRights, [])
    assert.ok(!move.outcome.castling?.paths.some((path) => path.side === "ai"))
  }
})

test("opposite-wing storms and central pushes do not alter current queenside cover", () => {
  const game = fromFen("2kr3r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R b KQ - 0 40")
  const move = annotated(game, "g7g5", { kingCover: true })
  assert.deepEqual(
    move.outcome.kingCover?.before,
    move.outcome.kingCover?.after
  )
  assert.equal(move.outcome.kingCover?.after[0].wing, "queenside")
  assert.deepEqual(move.outcome.kingCover?.relevantWings, [])
  for (const id of ["d2d4", "e2e4"]) {
    const central = annotated(newGame(), id, { kingCover: true })
    assert.deepEqual(
      central.outcome.kingCover?.before,
      central.outcome.kingCover?.after
    )
    assert.deepEqual(central.outcome.kingCover?.relevantWings, [])
  }
  const white = annotated(
    fromFen("4k3/8/8/8/8/8/5PPP/6K1 w - - 0 40"),
    "g2g3",
    { kingCover: true }
  )
  assert.equal(white.outcome.kingCover?.after[0].kind, "current")
  assert.deepEqual(white.outcome.kingCover?.after[0].nearFiles, ["f", "g", "h"])
})

test("new support to an unattacked queen or rook is support rather than rescue", () => {
  for (const piece of ["Q", "R"]) {
    const game = fromFen(`7k/8/8/8/8/3${piece}4/8/3B3K w - - 0 40`)
    const move = annotated(game, "d1e2", { support: true, relationships: true })
    const support = move.outcome.support?.addedFriendlySupport.find(
      (entry) => entry.target.square === index("d3")
    )
    assert.ok(support)
    assert.equal(support.beforeCount, 0)
    assert.equal(support.afterCount, 1)
    assert.equal(support.wasThreatened, false)
    assert.deepEqual(move.outcome.relationships?.resolvedThreats, [])
  }
})

test("ordinary purposeful pawn advances report bishop/queen openings without a penalty", () => {
  for (const [history, id, bishop] of [
    [["e2e4"], "e7e6", "f8"],
    [["e2e4"], "e7e5", "f8"],
    [[], "d2d4", "c1"],
    [["e2e4"], "g7g6", "f8"],
    [[], "b2b3", "c1"]
  ] as [string[], string, string][]) {
    const move = annotated(sequence(newGame(), history), id, { mobility: true })
    const opens = move.outcome.mobility?.changedOtherPieces.find(
      (piece) => piece.fromSquare === index(bishop)
    )
    assert.ok(
      opens && opens.after > opens.before && opens.newSquares.length > 0
    )
    assert.equal(
      move.outcome.mobility?.pawnAdvance?.squares,
      id.endsWith("4") || id.endsWith("5") ? 2 : 1
    )
    if (id.startsWith("e7") || id === "d2d4") {
      assert.ok(
        move.outcome.mobility?.changedOtherPieces.some(
          (piece) => piece.piece === "q" && piece.newSquares.length > 0
        )
      )
    }
  }
})

test("returning a king or rook never restores a future cover profile", () => {
  const start = fromFen("r3k2r/ppp2ppp/8/8/8/8/8/4K3 b kq - 0 40")
  const kingReturned = sequence(start, ["e8d8", "e1d1", "d8e8", "d1e1"])
  const king = annotated(kingReturned, "g7g5", {
    kingCover: true,
    castling: true
  })
  assert.deepEqual(king.outcome.kingCover?.before, [])
  assert.deepEqual(king.outcome.castling?.lostRights, [])
  const rookReturned = sequence(start, ["h8g8", "e1d1", "g8h8", "d1e1"])
  const rook = annotated(rookReturned, "g7g5", {
    kingCover: true,
    castling: true
  })
  assert.deepEqual(
    rook.outcome.kingCover?.before.map((profile) => profile.wing),
    ["queenside"]
  )
  assert.deepEqual(rook.outcome.kingCover?.relevantWings, [])
})

test("queenside kings on b/c home squares keep current cover without rights", () => {
  for (const file of ["b", "c"]) {
    const black = annotated(
      fromFen(`${file === "b" ? "1k6" : "2k5"}/ppp5/8/8/8/8/8/4K3 b - - 0 40`),
      "a7a6",
      { kingCover: true }
    )
    assert.equal(black.outcome.kingCover?.after[0].kind, "current")
    assert.equal(black.outcome.kingCover?.after[0].wing, "queenside")
    assert.deepEqual(black.outcome.kingCover?.after[0].nearFiles, [
      "a",
      "b",
      "c"
    ])
    const white = annotated(
      fromFen(`4k3/8/8/8/8/8/PPP5/${file === "b" ? "1K6" : "2K5"} w - - 0 40`),
      "a2a3",
      { kingCover: true }
    )
    assert.equal(white.outcome.kingCover?.after[0].kind, "current")
    assert.deepEqual(white.outcome.kingCover?.after[0].nearFiles, [
      "a",
      "b",
      "c"
    ])
  }
})

test("promotion and king-mobility options remain independent, immutable and opt-in", () => {
  const game = fromFen("8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72")
  const saved = JSON.stringify(game)
  const original = annotatedLegalMoves(game)
  const enriched = annotatedLegalMoves(game, { promotionReplies: true, kingMobility: true })
  assert.deepEqual(enriched.map((move) => move.id), original.map((move) => move.id))
  assert.ok(original.every((move) => move.outcome.promotionReplies === undefined && move.outcome.kingMobility === undefined))
  assert.ok(enriched.every((move) => move.outcome.mobility === undefined))
  assert.equal(JSON.stringify(game), saved)
  assert.deepEqual(enriched, annotatedLegalMoves(game, { promotionReplies: true, kingMobility: true }))
})

test("quiet promotions include all four legal roles even without an enemy capture", () => {
  const game = fromFen("8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72")
  const move = annotated(game, "h4f2", { promotionReplies: true, safety: true })
  const promotions = move.outcome.promotionReplies
  assert.ok(promotions)
  assert.deepEqual(new Set(promotions.map((reply) => reply.promotion)), new Set(["q", "r", "b", "n"]))
  for (const reply of promotions) {
    assert.equal(reply.from, index("h7"))
    assert.equal(reply.to, index("h8"))
    assert.deepEqual(reply.capturableBy, [])
    assert.equal(reply.netAfterPromotion, reply.promotion === "q" ? -8 : reply.promotion === "r" ? -4 : -2)
    assert.equal(reply.netAfterImmediateCapture, undefined)
  }
  assert.deepEqual(move.outcome.replyMaterialLosses, [])
  assert.deepEqual(annotated(game, "h4h7", { promotionReplies: true }).outcome.promotionReplies, [])
})

test("recapturable promotions preserve valid h-file control rather than inventing forced loss", () => {
  const game = fromFen("8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72")
  for (const id of ["a2b1", "h4h1", "h4f6"]) {
    const promotions = annotated(game, id, { promotionReplies: true }).outcome.promotionReplies
    assert.equal(promotions?.length, 4)
    for (const reply of promotions ?? []) {
      assert.ok(reply.capturableBy.some((piece) => piece.piece === "q"))
      assert.equal(reply.netAfterImmediateCapture, 1)
    }
  }
})

test("promotion material includes candidate compensation and an actual capture-promotion", () => {
  const game = fromFen("7r/6P1/8/r7/Q7/8/k7/6K1 b - - 0 40")
  const promotions = annotated(game, "a5a4", { promotionReplies: true }).outcome.promotionReplies
  assert.ok(promotions)
  const quiet = promotions.find((reply) => reply.id === "g7g8q")
  assert.equal(quiet?.netAfterPromotion, 1) // Queen9 gained, promotion gain8 conceded.
  const capture = promotions.find((reply) => reply.id === "g7h8q")
  assert.ok(capture)
  assert.equal(capture.captured, "r")
  assert.equal(capture.netAfterPromotion, -4) // 9 - rook5 - promotion8.
})

test("pinned promotion recapturers are excluded from the actual legal capture list", () => {
  for (const [rank, pinned] of [["R2r2k1", true], ["3r2k1", false]] as const) {
    const game = fromFen(`8/3P3p/8/8/${rank}/8/8/K7 b - - 0 40`)
    const promotions = annotated(game, "h7h6", { promotionReplies: true }).outcome.promotionReplies
    assert.equal(promotions?.length, 4)
    for (const reply of promotions ?? []) {
      assert.equal(reply.capturableBy.some((piece) => piece.square === index("d4")), !pinned)
    }
  }
})

test("underpromotion checks and promotion mates use each actual resulting board", () => {
  const check = annotated(fromFen("8/p5P1/7k/8/8/8/8/K7 b - - 0 40"), "a7a6", { promotionReplies: true }).outcome.promotionReplies
  assert.equal(check?.find((reply) => reply.promotion === "n")?.check, true)
  assert.equal(check?.find((reply) => reply.promotion === "q")?.check, false)
  const mate = annotated(fromFen("7k/p4P2/6K1/8/8/8/8/8 b - - 0 40"), "a7a6", { promotionReplies: true }).outcome.promotionReplies
  for (const reply of mate ?? []) {
    assert.equal(reply.checkmate, reply.promotion === "q" || reply.promotion === "r")
    if (reply.checkmate) assert.deepEqual(reply.capturableBy, [])
  }
})

test("queen and rook cutoffs report exact denied and newly available king destinations", () => {
  const queen = annotated(fromFen("7K/8/2k5/3q4/8/8/8/8 b - - 0 40"), "d5d7", { kingMobility: true }).outcome.kingMobility
  assert.ok(queen)
  assert.deepEqual(new Set(queen.before), new Set([index("h7"), index("g7")]))
  assert.deepEqual(queen.after, [index("g8")])
  assert.deepEqual(new Set(queen.deniedSquares), new Set([index("h7"), index("g7")]))
  assert.deepEqual(queen.newSquares, [index("g8")])
  assert.equal(queen.opponentBareKing, true)
  assert.deepEqual(queen.ownKingDistance, { before: 5, after: 5 })
  const rook = annotated(fromFen("7K/8/5k2/r7/8/8/8/8 b - - 0 40"), "a5a7", { kingMobility: true }).outcome.kingMobility
  assert.deepEqual(rook?.after, [index("g8")])
  assert.deepEqual(rook?.deniedSquares, [index("h7")])
  const closer = annotated(fromFen("7K/8/5k2/r7/8/8/8/8 b - - 0 40"), "f6f7", { kingMobility: true }).outcome.kingMobility
  assert.deepEqual(closer?.ownKingDistance, { before: 2, after: 2 })
})

test("zero king destinations remain distinct from checks with nonking replies and stalemate", () => {
  const block = annotated(fromFen("7K/7R/6kq/8/8/8/8/8 b - - 0 40"), "h6g7", { kingMobility: true })
  assert.equal(block.outcome.check, true)
  assert.equal(block.outcome.checkmate, false)
  assert.deepEqual(block.outcome.kingMobility?.after, [])
  assert.equal(block.outcome.kingMobility?.otherLegalReplyCount, 1)
  assert.equal(block.outcome.kingMobility?.afterInCheck, true)
  const pawn = annotated(fromFen("7K/5q2/2k5/8/8/8/P7/8 b - - 0 40"), "c6d6", { kingMobility: true })
  assert.equal(pawn.outcome.stalemate, false)
  assert.deepEqual(pawn.outcome.kingMobility?.after, [])
  assert.equal(pawn.outcome.kingMobility?.otherLegalReplyCount, 2)
  assert.equal(pawn.outcome.kingMobility?.opponentBareKing, false)
  assert.equal(pawn.outcome.kingMobility?.opponentPawnCount, 1)
  assert.equal(pawn.outcome.kingMobility?.ownKingDistance, undefined)
  const stalemate = annotated(fromFen("7K/5q2/2k5/8/8/8/8/8 b - - 0 40"), "c6d6", { kingMobility: true, promotionReplies: true })
  assert.equal(stalemate.outcome.stalemate, true)
  assert.deepEqual(stalemate.outcome.kingMobility?.after, [])
  assert.equal(stalemate.outcome.kingMobility?.otherLegalReplyCount, 0)
  assert.deepEqual(stalemate.outcome.promotionReplies, [])
})

test("opening blockage is not a mating claim and castling remains a king destination", () => {
  const opening = annotated(newGame(), "d2d4", { kingMobility: true }).outcome.kingMobility
  assert.ok(opening)
  assert.deepEqual(opening.before, [])
  assert.deepEqual(opening.after, [])
  assert.equal(opening.otherLegalReplyCount, 20)
  assert.equal(opening.opponentNonPawnNonKingCount, 7)
  assert.equal(opening.opponentPawnCount, 8)
  assert.equal(opening.opponentBareKing, false)
  assert.equal(opening.ownKingDistance, undefined)
  const castle = annotated(fromFen("6k1/7p/8/8/8/8/8/4K2R b K - 0 40"), "h7h6", { kingMobility: true }).outcome.kingMobility
  assert.ok(castle?.before.includes(index("g1")))
  assert.ok(castle?.after.includes(index("g1")))
})

test("a checking queen sacrifice is still a loss even when king destinations decrease", () => {
  const game = fromFen("7K/8/2k5/3q4/8/8/8/8 b - - 0 40")
  const sacrifice = annotated(game, "d5g8", { kingMobility: true, safety: true })
  assert.equal(sacrifice.outcome.check, true)
  assert.deepEqual(sacrifice.outcome.kingMobility?.after, [index("g8")])
  assert.ok(sacrifice.outcome.replyMaterialLosses?.some((loss) => loss.piece === "q" && loss.capturedBy.piece === "k" && loss.netMaterial === -9))
  const protectedQueen = annotated(fromFen("5k1K/8/8/3q4/8/8/8/8 b - - 0 40"), "d5g8", { kingMobility: true, safety: true })
  assert.equal(protectedQueen.outcome.checkmate, true)
  assert.deepEqual(protectedQueen.outcome.kingMobility?.after, [])
  assert.deepEqual(protectedQueen.outcome.replyMaterialLosses, [])
})
