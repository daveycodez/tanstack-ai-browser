import assert from "node:assert/strict"
import { test } from "node:test"
import { annotatedLegalMoves, applyMove, colorForSide, fromFen, legalMoves, newGame, randomHumanColor, toPgn } from "./chess.ts"
import { buildMoveAnalysis } from "./move-analysis.ts"
import { describePosition } from "./ai-position.ts"
import { SHARED_SYSTEM_PROMPT, systemPromptFor } from "./shared-prompt.ts"
import type { MoveContextOptions } from "./chess.ts"

const context: MoveContextOptions = { relationships: true, support: true, mobility: true, castling: true, kingCover: true, promotionReplies: true, kingMobility: true, safety: true }
const play = (color: "white" | "black", ids: string[]) => ids.reduce(applyMove, newGame(color))

test("White opens for either assignment and only physical piece ownership changes", () => {
  const white = newGame("white"), black = newGame("black")
  assert.equal(white.turn, "human")
  assert.equal(black.turn, "ai")
  assert.equal(white.fen, black.fen)
  assert.deepEqual(legalMoves(white), legalMoves(black))
  assert.equal(black.board[60]?.side, "ai")
  assert.equal(black.board[4]?.side, "human")
  const replied = play("black", ["e2e4", "e7e5"])
  assert.deepEqual(replied.history.map(move => move.side), ["ai", "human"])
  assert.equal(replied.turn, "ai")
  assert.equal(replied.humanColor, "black")
})

test("the random bit assigns exactly half of possible bytes to each color", t => {
  let byte = 0
  t.mock.method(crypto, "getRandomValues", values => { (values as Uint8Array)[0] = byte; return values })
  const counts = { white: 0, black: 0 }
  for (byte = 0; byte < 256; byte++) counts[randomHumanColor()]++
  assert.deepEqual(counts, { white: 128, black: 128 })
  byte = 1
  assert.equal(newGame().humanColor, "black")
})

test("legacy saves retain White ownership after a move", () => {
  const { humanColor: _oldAssignment, ...legacy } = newGame("white")
  assert.equal(colorForSide(legacy, "human"), "white")
  assert.equal(colorForSide(legacy, "ai"), "black")
  const next = applyMove(legacy, "e2e4")
  assert.equal(next.history[0].side, "human")
  assert.equal(next.turn, "ai")
  assert.equal(next.board[36]?.side, "human")
})

test("mate winners and PGN players/results follow ownership for both colors", () => {
  const blackWin = ["f2f3", "e7e5", "g2g4", "d8h4"]
  const whiteWin = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"]
  for (const color of ["white", "black"] as const) {
    const blackMate = play(color, blackWin), whiteMate = play(color, whiteWin)
    assert.equal(blackMate.status, color === "black" ? "human-won" : "ai-won")
    assert.equal(whiteMate.status, color === "white" ? "human-won" : "ai-won")
    assert.match(toPgn(blackMate), /\[Result "0-1"\]/)
    assert.match(toPgn(whiteMate), /\[Result "1-0"\]/)
    assert.ok(toPgn(blackMate).includes(`[${color === "black" ? "Black" : "White"} "You"]`))
  }
})

test("all annotated outcomes retain physical facts when ownership swaps, including castling sides", () => {
  for (const fen of [
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq - 0 1",
    "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
    "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"
  ]) {
    const white = annotatedLegalMoves(fromFen(fen, "white"), context)
    const black = annotatedLegalMoves(fromFen(fen, "black"), context)
    const remapped: unknown = JSON.parse(JSON.stringify(black), (key, value: unknown) => key === "side" ? value === "human" ? "ai" : "human" : value)
    assert.deepEqual(remapped, white)
  }
})

test("White AI receives actual White pieces, White castling and matching system/history/outcome colors", () => {
  const game = play("black", ["e2e4", "e7e5"])
  const input = buildMoveAnalysis({ game, moveOrderSeed: "white-ai" })
  assert.match(input.systemPrompt, /^Play White\./)
  assert.match(input.systemPrompt, /Negative net means White loses material/)
  assert.match(input.prompt, /White pieces:\nKing: e1/)
  assert.match(input.prompt, /Black pieces:\nKing: e8/)
  assert.match(input.prompt, /White: e4 \(e2e4\)\nBlack: e5 \(e7e5\)/)
  assert.match(input.prompt, /White in check: no/)
  assert.match(input.prompt, /Black capture possibilities/)
  assert.equal(systemPromptFor(newGame("white")), SHARED_SYSTEM_PROMPT)
  const castle = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "black")
  const choices = buildMoveAnalysis({ game: castle }).choices
  assert.ok(choices.find(move => move.id === "e1g1")?.outcome.includes("CASTLES kingside"))
  const decoded = describePosition(game)
  assert.match(decoded, /White pieces \(you\):/)
  assert.match(decoded, /Black pieces \(opponent\):/)
  assert.match(decoded, /Black pawns advance toward rank 1; White pawns advance toward rank 8/)
})

test("White AI mate cards and warnings describe actual colors without changing legal action labels", () => {
  const game = fromFen("rnbqkbnr/ppppp2p/5p2/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "black")
  const input = buildMoveAnalysis({ game })
  assert.match(input.prompt, /White can WIN THIS TURN/)
  assert.ok(input.choices.find(choice => choice.id === "d1h5")?.outcome.includes("CHECKMATE: wins now"))
  assert.deepEqual(new Set(input.choices.map(choice => choice.id)), new Set(legalMoves(game).map(move => move.id)))
})
