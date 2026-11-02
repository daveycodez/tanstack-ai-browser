import assert from "node:assert/strict"
import { test } from "node:test"
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
      supporters: [{ piece: "b", square: index("e2") }]
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
