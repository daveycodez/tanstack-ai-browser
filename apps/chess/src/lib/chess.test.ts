import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyMove,
  fromFen,
  legalMoves,
  newGame,
  squareName,
  toPgn,
  unsafeKingDestinations
} from "./chess.ts"
import type { Game } from "./chess.ts"

const index = (square: string) =>
  (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97
const moveIds = (game: Game) => legalMoves(game).map((move) => move.id)
const sequence = (game: Game, moves: string[]) => moves.reduce(applyMove, game)

test("starts with all 32 chess pieces and exactly 20 legal white moves", () => {
  const game = newGame()
  assert.equal(game.board.filter(Boolean).length, 32)
  assert.deepEqual(game.board[index("a8")], { side: "ai", type: "r" })
  assert.deepEqual(game.board[index("e1")], { side: "human", type: "k" })
  assert.equal(legalMoves(game).length, 20)
  assert.equal(game.turn, "human")
  assert.equal(game.status, "playing")
  assert.equal(game.inCheck, false)
  assert.notEqual(newGame().sessionId, game.sessionId)
  assert.equal(squareName(0), "a8")
  assert.equal(squareName(63), "h1")
  for (const invalid of [-1, 64, 0.1, NaN])
    assert.throws(() => squareName(invalid))
})

test("applies moves immutably, preserving session and opponent settings", () => {
  const game = newGame()
  game.opponent = { model: "prompt-api", thinking: false }
  const before = JSON.stringify(game)
  const next = applyMove(game, "e2e4")
  assert.equal(JSON.stringify(game), before)
  assert.equal(next.sessionId, game.sessionId)
  assert.deepEqual(next.opponent, game.opponent)
  assert.equal(next.board[index("e2")], null)
  assert.deepEqual(next.board[index("e4")], { side: "human", type: "p" })
  assert.equal(next.turn, "ai")
  assert.equal(next.history[0]?.notation, "e4")
  assert.equal(next.history[0]?.piece, "p")
  assert.equal(next.positions.length, 2)
})

test("rejects illegal, malformed, and out-of-turn moves", () => {
  const game = newGame()
  for (const id of ["e2e5", "a7a6", "e4", "e2e4q", "", "e2-e4"]) {
    assert.throws(() => applyMove(game, id))
  }
  assert.throws(() => applyMove(applyMove(game, "e2e4"), "d2d4"))
})

test("castles both ways, moving the rook and recording SAN", () => {
  const game = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
  assert.ok(moveIds(game).includes("e1g1"))
  assert.ok(moveIds(game).includes("e1c1"))
  const short = applyMove(game, "e1g1")
  assert.deepEqual(short.board[index("g1")], { side: "human", type: "k" })
  assert.deepEqual(short.board[index("f1")], { side: "human", type: "r" })
  assert.equal(short.board[index("h1")], null)
  assert.equal(short.history[0]?.notation, "O-O")
  const long = applyMove(game, "e1c1")
  assert.deepEqual(long.board[index("d1")], { side: "human", type: "r" })
  assert.equal(long.history[0]?.notation, "O-O-O")
})

test("does not castle through check or regain castling rights after a rook moves", () => {
  const attacked = fromFen("r3kr1r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
  assert.ok(!moveIds(attacked).includes("e1g1"))
  assert.ok(moveIds(attacked).includes("e1c1"))
  const moved = sequence(fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), [
    "h1h2",
    "h8h7",
    "h2h1",
    "h7h8"
  ])
  assert.ok(!moveIds(moved).includes("e1g1"))
  assert.ok(!moveIds(newGame()).includes("e1g1"))
})

test("en passant captures the pawn on its actual square and expires after one turn", () => {
  const game = sequence(newGame(), ["e2e4", "a7a6", "e4e5", "d7d5"])
  const move = legalMoves(game).find((item) => item.id === "e5d6")
  assert.deepEqual(move?.captures, [index("d5")])
  const next = applyMove(game, "e5d6")
  assert.equal(next.board[index("d5")], null)
  assert.deepEqual(next.board[index("d6")], { side: "human", type: "p" })
  assert.equal(next.history.at(-1)?.captured, "p")
  const expired = sequence(game, ["h2h3", "a6a5"])
  assert.ok(!moveIds(expired).includes("e5d6"))
})

test("never exposes the king through a pinned piece or en passant", () => {
  const pinned = fromFen("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1")
  assert.ok(!moveIds(pinned).includes("e2f2"))
  assert.ok(moveIds(pinned).includes("e2e8"))
  assert.throws(() => applyMove(pinned, "e2f2"))
  const discovered = fromFen("7k/8/8/r4pPK/8/8/8/8 w - f6 0 1")
  assert.ok(!moveIds(discovered).includes("g5f6"))
})

test("offers all four explicit promotion choices, including capture underpromotion", () => {
  const game = fromFen("1r5k/P7/8/8/8/8/8/7K w - - 0 1")
  const quiet = legalMoves(game).filter((move) => move.id.startsWith("a7a8"))
  assert.deepEqual(quiet.map((move) => move.promotion).sort(), [
    "b",
    "n",
    "q",
    "r"
  ])
  assert.ok(quiet.every((move) => move.promotes))
  assert.throws(() => applyMove(game, "a7a8"))
  const next = applyMove(game, "a7b8n")
  assert.deepEqual(next.board[index("b8")], { side: "human", type: "n" })
  assert.equal(next.history[0]?.captured, "r")
  assert.equal(next.history[0]?.promotion, "n")
  assert.equal(next.history[0]?.promoted, true)
  assert.deepEqual(next.history[0]?.captures, [index("b8")])
})

test("check permits only evasions and checkmate ends the game", () => {
  const checked = fromFen("k3r3/8/8/8/8/8/8/R3K3 w Q - 0 1")
  assert.equal(checked.inCheck, true)
  assert.ok(!moveIds(checked).includes("a1a2"))
  const mate = sequence(newGame(), ["f2f3", "e7e5", "g2g4", "d8h4"])
  assert.equal(mate.status, "ai-won")
  assert.equal(mate.inCheck, true)
  assert.equal(mate.history.at(-1)?.notation, "Qh4#")
  assert.deepEqual(legalMoves(mate), [])
  assert.throws(() => applyMove(mate, "e2e4"), /already over/)
  assert.match(toPgn(mate), /0-1/)
  const whiteMate = sequence(newGame(), [
    "e2e4",
    "e7e5",
    "d1h5",
    "b8c6",
    "f1c4",
    "g8f6",
    "h5f7"
  ])
  assert.equal(whiteMate.status, "human-won")
})

test("identifies stalemate separately from checkmate", () => {
  const game = fromFen("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1")
  assert.equal(game.status, "draw")
  assert.equal(game.drawReason, "Stalemate")
  assert.equal(game.inCheck, false)
  assert.deepEqual(legalMoves(game), [])
})

test("detects threefold repetition after a JSON persistence roundtrip", () => {
  let game = newGame()
  for (const id of [
    "g1f3",
    "g8f6",
    "f3g1",
    "f6g8",
    "g1f3",
    "g8f6",
    "f3g1",
    "f6g8"
  ]) {
    game = applyMove(JSON.parse(JSON.stringify(game)) as Game, id)
  }
  assert.equal(game.status, "draw")
  assert.equal(game.drawReason, "Threefold repetition")
  assert.equal(game.history.length, 8)
  assert.match(toPgn(game), /1\/2-1\/2/)
})

test("uses the fifty-move clock and resets it after a pawn move or capture", () => {
  const draw = applyMove(fromFen("7k/8/8/8/8/8/R7/7K w - - 99 1"), "a2a3")
  assert.equal(draw.status, "draw")
  assert.equal(draw.drawReason, "Fifty-move rule")
  const pawn = applyMove(fromFen("7k/8/8/8/8/8/P7/7K w - - 99 1"), "a2a3")
  assert.equal(pawn.status, "playing")
  assert.equal(pawn.fen.split(" ")[4], "0")
  const capture = applyMove(fromFen("7k/8/8/8/8/n7/R7/7K w - - 99 1"), "a2a3")
  assert.equal(capture.status, "playing")
  assert.equal(capture.fen.split(" ")[4], "0")
})

test("detects insufficient material without treating a rook as insufficient", () => {
  for (const fen of [
    "7k/8/8/8/8/8/8/7K w - - 0 1",
    "7k/8/8/8/8/8/N7/7K w - - 0 1",
    "7k/8/8/8/8/8/B7/7K w - - 0 1"
  ]) {
    const game = fromFen(fen)
    assert.equal(game.status, "draw")
    assert.equal(game.drawReason, "Insufficient material")
  }
  assert.equal(fromFen("7k/8/8/8/8/8/R7/7K w - - 0 1").status, "playing")
})

test("PGN preserves legal SAN and custom starting positions", () => {
  const game = sequence(newGame(), ["e2e4", "e7e5", "g1f3"])
  assert.match(toPgn(game), /1\. e4 e5 2\. Nf3/)
  const custom = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
  assert.match(toPgn(applyMove(custom, "e1c1")), /\[FEN /)
  const corrupted = { ...game, fen: newGame().fen }
  assert.throws(() => legalMoves(corrupted), /does not match/)
})


test("mate danger squares are empty, adjacent and include attacks revealed by the king leaving", () => {
  const game = fromFen("2k2bnr/2Bnp2p/4r1p1/2R5/B2P4/2RK4/P3q2P/8 w - - 0 31")
  assert.equal(game.status, "ai-won")
  assert.equal(game.inCheck, true)
  const before = JSON.stringify(game)
  assert.deepEqual(unsafeKingDestinations(game).map(squareName).sort(), ["c2", "c4", "d2", "e3", "e4"])
  assert.equal(JSON.stringify(game), before)
})
test("king safety includes a pinned enemy knight's attacks", () => {
  const game = fromFen("4k3/4n3/8/8/2K5/8/8/4R3 w - - 0 1")
  assert.deepEqual(unsafeKingDestinations(game).map(squareName), ["d5"])
})
test("danger calculation excludes safe destinations and sees a rook ray behind the old king square", () => {
  const game = fromFen("k3r3/8/8/8/8/8/4K3/8 w - - 0 1")
  assert.deepEqual(unsafeKingDestinations(game).map(squareName).sort(), ["e1", "e3"])
})
