import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, fromFen, newGame } from "./chess.ts"
import type { Game } from "./chess.ts"
import { boardFrame, nextBoardMotion } from "./board-motion.ts"
import { SOUND_CUES, soundCuesForMove } from "./game-audio.ts"

function cues(before: Game, id: string) {
  const after = applyMove(before, id)
  const motion = nextBoardMotion(boardFrame(before), after)
  assert.ok(motion, `Expected committed-move feedback for ${id}`)
  return soundCuesForMove(motion, after)
}
function replay(ids: string[]) {
  return ids.reduce(applyMove, newGame())
}

test("a quiet move and a capture have different audible feedback", () => {
  assert.deepEqual(cues(newGame(), "e2e4"), ["move"])
  assert.deepEqual(cues(replay(["e2e4", "d7d5"]), "e4d5"), ["capture"])
})
test("castling has its own double-placement cue", () => {
  const game = fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 40")
  assert.deepEqual(cues(game, "e8g8"), ["castle"])
  assert.deepEqual(cues(game, "e8c8"), ["castle"])
})
test("promotion does not suppress its capture or check cue", () => {
  const game = fromFen("7k/8/8/8/8/8/p7/1R5K b - - 0 40")
  assert.deepEqual(cues(game, "a2b1q"), ["capture", "promotion", "check"])
})
test("checkmate has a result cue rather than an ordinary check alert", () => {
  const blackMate = replay(["f2f3", "e7e5", "g2g4"])
  assert.deepEqual(cues(blackMate, "d8h4"), ["move", "checkmate-loss"])
  const whiteMate = replay(["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"])
  assert.deepEqual(cues(whiteMate, "h5f7"), ["capture", "checkmate-win"])
})
test("an automatic draw has distinct result feedback", () => {
  const game = fromFen("k7/6p1/5K2/8/8/8/8/8 w - - 0 40")
  assert.deepEqual(cues(game, "f6g7"), ["capture", "draw"])
})
test("all requested cues have distinct bounded, audible midrange patterns", () => {
  const patterns = Object.values(SOUND_CUES)
  assert.equal(new Set(patterns.map((notes) => JSON.stringify(notes))).size, patterns.length)
  for (const notes of patterns) {
    assert.ok(notes.some(([from, to]) => Math.max(from, to) >= 300))
    for (const [from, to, duration, gain, offset] of notes) {
      assert.ok(from > 0 && to > 0)
      assert.ok(duration > 0 && duration < 1)
      assert.ok(gain > 0 && gain <= 0.15)
      assert.ok(offset >= 0 && offset < 1)
    }
  }
})


test("win and loss use long, opposite result phrases with a resolved chord", () => {
  const end = (notes: typeof SOUND_CUES.check) =>
    Math.max(...notes.map(([, , duration, , offset]) => duration + offset))
  const win = SOUND_CUES["checkmate-win"]
  const loss = SOUND_CUES["checkmate-loss"]
  assert.ok(end(SOUND_CUES.check) < 0.3)
  for (const result of [win, loss]) {
    assert.ok(end(result) >= 1.2 && end(result) <= 1.5)
    const lastOnset = Math.max(...result.map(note => note[4]))
    assert.equal(result.filter(note => note[4] === lastOnset).length, 3)
  }
  assert.ok(win[0][0] < win[1][0] && win[1][0] < win[2][0])
  assert.ok(loss[0][0] > loss[1][0] && loss[1][0] > loss[2][0])
  assert.notEqual(win[0][5], loss[0][5])
})
