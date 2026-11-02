import assert from "node:assert/strict"
import { test } from "node:test"
import { annotatedLegalMoves, applyMove, fromFen, newGame } from "./chess.ts"
import { formatMoveOutcome } from "./ai-outcomes.ts"

test("spells out immediate checkmate instead of relying on SAN symbols", () => {
  const game = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())
  const move = annotatedLegalMoves(game).find((move) => move.id === "d8h4")
  assert.ok(move)
  assert.match(
    formatMoveOutcome(move, "ai"),
    /^d8h4: queen d8-h4; outcome: CHECKMATE, wins immediately$/
  )
})

test("names a captured piece and states zero immediate recapturers", () => {
  const game = fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")
  const move = annotatedLegalMoves(game).find((move) => move.id === "e5d4")
  assert.ok(move)
  const text = formatMoveOutcome(move, "ai")
  assert.match(text, /captures white queen \(9\)/)
  assert.match(text, /legal recapturers: 0/)
})

test("formats a real defender count and cheapest legal recapturer", () => {
  const game = fromFen("6k1/8/8/2p1p3/3P4/2P5/8/6K1 b - - 0 1")
  const move = annotatedLegalMoves(game).find((move) => move.id === "e5d4")
  assert.ok(move)
  const text = formatMoveOutcome(move, "ai")
  assert.match(text, /captures white pawn \(1\)/)
  assert.match(text, /legal recapturers: 1, cheapest white pawn \(1\) from c3/)
})

test("keeps opening outcome lines concise enough for the existing prompt guard", () => {
  const game = applyMove(newGame(), "e2e4")
  const moves = annotatedLegalMoves(game)
  assert.equal(moves.length, 20)
  const text = moves.map((move) => formatMoveOutcome(move, "ai")).join("\n")
  assert.ok(text.length < 4000)
  assert.ok(
    moves.every((move) => formatMoveOutcome(move, "ai").includes("outcome:"))
  )
})

test("spells out checks, stalemates and an opponent mating reply", () => {
  const checkGame = ["e2e4", "f7f6"].reduce(applyMove, newGame())
  const check = annotatedLegalMoves(checkGame).find(
    (move) => move.id === "d1h5"
  )
  assert.ok(check)
  assert.match(
    formatMoveOutcome(check, "human"),
    /outcome: CHECK, opponent must respond/
  )
  const staleGame = fromFen("8/8/8/8/5q2/8/5k2/7K b - - 0 1")
  const stale = annotatedLegalMoves(staleGame).find(
    (move) => move.id === "f4g3"
  )
  assert.ok(stale)
  assert.match(formatMoveOutcome(stale, "ai"), /STALEMATE, draw/)
  const defense = fromFen(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const unsafe = annotatedLegalMoves(defense).find((move) => move.id === "b7b6")
  assert.ok(unsafe)
  assert.match(
    formatMoveOutcome(unsafe, "ai"),
    /DANGER: opponent can CHECKMATE next turn/
  )
})

test("states conditional exchange loss without treating a promotion as a free piece", () => {
  const trade = fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1")
  const queen = annotatedLegalMoves(trade).find((move) => move.id === "d8d4")
  assert.ok(queen)
  assert.match(formatMoveOutcome(queen, "ai"), /if recaptured: net material -4/)
  const promotion = fromFen("1rk5/P7/8/8/8/8/8/7K w - - 0 1")
  const pawn = annotatedLegalMoves(promotion).find(
    (move) => move.id === "a7b8q"
  )
  assert.ok(pawn)
  assert.equal(pawn.outcome.recapture.count, 1)
  assert.match(
    formatMoveOutcome(pawn, "human"),
    /if recaptured: net material \+4/
  )
})

test("spells out castling and the actual en passant captured square", () => {
  const castling = fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
  const king = annotatedLegalMoves(castling).find((move) => move.id === "e8g8")
  assert.ok(king)
  assert.match(formatMoveOutcome(king, "ai"), /outcome: castles kingside/)
  const ep = fromFen("3r3k/8/8/3pP3/8/8/8/7K w - d6 0 1")
  const pawn = annotatedLegalMoves(ep).find((move) => move.id === "e5d6")
  assert.ok(pawn)
  assert.match(
    formatMoveOutcome(pawn, "human"),
    /captures black pawn \(1\) en passant on d5/
  )
})

test("manual queen priority changes prompt values and conditional loss without changing moves", () => {
  const trade = fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1")
  const queen = annotatedLegalMoves(trade).find((move) => move.id === "d8d4")
  assert.ok(queen)
  assert.match(
    formatMoveOutcome(queen, "ai", 9),
    /if recaptured: net material -4/
  )
  assert.match(
    formatMoveOutcome(queen, "ai", 12),
    /if recaptured: net material -7/
  )
  const free = fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")
  const pawn = annotatedLegalMoves(free).find((move) => move.id === "e5d4")
  assert.ok(pawn)
  assert.match(formatMoveOutcome(pawn, "ai", 12), /captures white queen \(12\)/)
})
