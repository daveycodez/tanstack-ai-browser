import assert from "node:assert/strict"
import { test } from "node:test"
import { applyMove, fromFen, newGame } from "./chess.ts"
import { describePosition } from "./ai-position.ts"

test("describes every starting piece in plain English without raw FEN", () => {
  const game = applyMove(newGame("white"), "e2e4")
  const text = describePosition(game)
  assert.match(
    text,
    /Black pieces \(you\):\nKing: e8\nQueens: d8\nRooks: a8, h8\nBishops: c8, f8\nKnights: b8, g8/
  )
  assert.match(text, /White pieces \(opponent\):\nKing: e1/)
  assert.match(text, /Pawns: e4, a2, b2, c2, d2, f2, g2, h2/)
  assert.match(text, /Side to move: Black/)
  assert.match(text, /Black retains castling rights: kingside and queenside/)
  assert.match(text, /White retains castling rights: kingside and queenside/)
  assert.ok(!text.includes(game.fen))
  assert.ok(!text.includes("rnbqkbnr"))
})

test("decodes en passant and move counters into explicit fields", () => {
  const game = ["e2e4", "a7a6", "e4e5", "d7d5"].reduce(applyMove, newGame("white"))
  const text = describePosition(game)
  assert.match(text, /En passant target square: d6/)
  assert.match(
    text,
    /Half-moves since the last pawn move or capture: 0. Full move number: 3/
  )
  assert.match(text, /Side to move: White/)
})

test("states check, missing castling rights and absent pieces explicitly", () => {
  const text = describePosition(fromFen("4k3/8/8/8/8/8/4R3/4K3 b - - 7 12"))
  assert.match(text, /Black king is in check/)
  assert.match(
    text,
    /Black pieces \(you\):\nKing: e8\nQueens: none\nRooks: none/
  )
  assert.match(
    text,
    /White pieces \(opponent\):\nKing: e1\nQueens: none\nRooks: e2/
  )
  assert.match(text, /Black retains castling rights: none/)
  assert.match(text, /White retains castling rights: none/)
  assert.match(text, /En passant target square: none/)
})

test("retains multiple promoted queens without inventing missing pieces", () => {
  const text = describePosition(fromFen("4k3/8/8/8/8/8/QQ6/4K3 b - - 0 1"))
  assert.match(text, /Queens: a2, b2/)
})
