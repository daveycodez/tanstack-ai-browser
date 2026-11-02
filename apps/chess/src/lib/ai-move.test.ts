import assert from "node:assert/strict"
import { test } from "node:test"
import { applyMove, fromFen, newGame } from "./chess.ts"
import { resolveMoveId, resolveCanonicalSan } from "./ai-move.ts"

test("resolves legal UCI and SAN to the same move without choosing a substitute", () => {
  const game = applyMove(newGame(), "e2e4")
  assert.equal(resolveMoveId(game, "e7e5"), "e7e5")
  assert.equal(resolveMoveId(game, " e5 "), "e7e5")
  assert.equal(resolveMoveId(game, "Nc6"), "b8c6")
  assert.throws(() => resolveMoveId(game, "Nxd4"), /illegal or ambiguous/)
  assert.throws(() => resolveMoveId(game, "e2e4"), /illegal or ambiguous/)
  assert.throws(() => resolveMoveId(game, "first"), /illegal or ambiguous/)
})

test("accepts a mating SAN answer with or without its check suffix", () => {
  const game = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())
  for (const answer of ["Qh4#", "Qh4", "d8h4"]) {
    const id = resolveMoveId(game, answer)
    assert.equal(id, "d8h4")
    assert.equal(applyMove(game, id).status, "ai-won")
  }
})

test("retains promotion choice and castling when interpreting SAN", () => {
  const promotion = fromFen("7k/8/8/8/8/8/p7/7K b - - 0 1")
  assert.equal(resolveMoveId(promotion, "a1=Q+"), "a2a1q")
  assert.equal(resolveMoveId(promotion, "a1=N"), "a2a1n")
  const castle = fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
  assert.equal(resolveMoveId(castle, "O-O"), "e8g8")
})

test("rejects ambiguous SAN rather than picking the first matching piece", () => {
  const game = fromFen("1n3n1k/8/8/8/8/8/P7/K7 b - - 0 1")
  assert.throws(() => resolveMoveId(game, "Nd7"), /illegal or ambiguous/)
  assert.equal(resolveMoveId(game, "Nbd7"), "b8d7")
  assert.equal(resolveMoveId(game, "Nfd7"), "f8d7")
})

test("the canonical-SAN contract requires exact engine notation rather than UCI, suffix guessing, or whitespace normalization", () => {
  const mate = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())
  assert.equal(resolveCanonicalSan(mate, "Qh4#"), "d8h4")
  for (const answer of ["Qh4", "Qh4+", " Qh4#", "Qh4# ", "d8h4", "first"])
    assert.throws(
      () => resolveCanonicalSan(mate, answer),
      /noncanonical or illegal SAN/
    )
  const castle = fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
  assert.equal(resolveCanonicalSan(castle, "O-O"), "e8g8")
  assert.equal(resolveCanonicalSan(castle, "O-O-O"), "e8c8")
  assert.throws(
    () => resolveCanonicalSan(castle, "0-0"),
    /noncanonical or illegal SAN/
  )
  const ambiguous = fromFen("1n3n1k/8/8/8/8/8/P7/K7 b - - 0 1")
  assert.equal(resolveCanonicalSan(ambiguous, "Nbd7"), "b8d7")
  assert.equal(resolveCanonicalSan(ambiguous, "Nfd7"), "f8d7")
  assert.throws(
    () => resolveCanonicalSan(ambiguous, "Nd7"),
    /noncanonical or illegal SAN/
  )
})
