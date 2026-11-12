import assert from "node:assert/strict"
import test from "node:test"
import { Chess } from "chess.js"
import { assessEngineChoice, assessMove } from "../../bench/assess-move.ts"
import { RECORDED_CASES } from "../../bench/recorded-cases.ts"
import { CASES } from "../../bench/cases.ts"
import type { BenchmarkCase, EngineReview } from "../../bench/types.ts"
function review(scores: [string, "cp" | "mate", number][]): EngineReview {
  return {
    depth: 16,
    nodes: 1_000_000,
    sourceRun: "test",
    game: 1,
    ply: 1,
    grades: scores.map(([moveId, scoreType, score]) => ({
      moveId,
      scoreType,
      score,
      depth: 16,
      nodes: 100,
      bound: false,
      pv: []
    }))
  }
}

test("different winning plans and all winning mate distances are acceptable", () => {
  const r = review([
    ["best", "cp", 652],
    ["alternative", "cp", 303],
    ["mateSoon", "mate", 1],
    ["mateLater", "mate", 5]
  ])
  assert.equal(assessEngineChoice(r, "alternative").verdict, "acceptable")
  assert.equal(assessEngineChoice(r, "mateLater").verdict, "acceptable")
})
test("near-equal moves pass and small uncertain differences are not failures", () => {
  const r = review([
    ["a", "cp", 86],
    ["b", "cp", -19],
    ["c", "cp", -73],
    ["king", "cp", -156]
  ])
  for (const id of ["a", "b", "c"])
    assert.equal(assessEngineChoice(r, id).verdict, "acceptable")
  assert.equal(assessEngineChoice(r, "king").verdict, "uncertain")
})
test("clear losses remain mistakes and already-losing positions stay diagnostic", () => {
  const r = review([
    ["safe", "cp", 147],
    ["fork", "cp", -616]
  ])
  assert.equal(assessEngineChoice(r, "fork").verdict, "mistake")
  assert.equal(
    assessEngineChoice(
      review([
        ["win", "cp", 453],
        ["equal", "cp", -6]
      ]),
      "equal"
    ).verdict,
    "mistake"
  )
  assert.equal(
    assessEngineChoice(
      review([
        ["defense", "cp", -700],
        ["counterplay", "cp", -900]
      ]),
      "counterplay"
    ).verdict,
    "ungraded"
  )
  const limited = review([
    ["a", "cp", 10],
    ["b", "cp", -700]
  ])
  limited.grades[1].depth = 13
  assert.equal(assessEngineChoice(limited, "b").verdict, "uncertain")
})
test("all immediate mates and an independently verified mate-in-two pass", () => {
  const f: BenchmarkCase = {
    id: "winning-plans",
    label: "Winning plans",
    description: "",
    fen: "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1",
    expectedMoveIds: ["g6g7"],
    orders: []
  }
  for (const id of ["g6g7", "g6g8", "g6f6"])
    assert.equal(assessMove(f, id).verdict, "acceptable")
  const b = new Chess(f.fen)
  b.move("Qf6+")
  assert.deepEqual(b.moves(), ["Kh7"])
  b.move("Kh7")
  b.move("Qh4#")
  assert.ok(b.isCheckmate())
  assert.equal(assessMove(f, "g6f5").verdict, "mistake") // Stalemate declines a known win.
})
test("multiple legitimate defenses pass; immediate-mate blunders still fail", () => {
  const f = CASES.find((f) => f.id === "stop-immediate-mate")
  assert.ok(f?.expectedMoveIds)
  assert.ok(f.expectedMoveIds.length > 1)
  for (const id of f.expectedMoveIds)
    assert.equal(assessMove(f, id).verdict, "acceptable", id)
  assert.equal(assessMove(f, "a7a6").verdict, "mistake")
})
test("missing a local opportunity is not automatically a gameplay mistake", () => {
  const f = CASES.find((f) => f.id === "observed-free-bishop-on-h6")
  assert.ok(f)
  assert.equal(assessMove(f, "g7g6").verdict, "ungraded")
  for (const id of ["g7h6", "g8h6", "h8h6"])
    assert.equal(assessMove(f, id).verdict, "acceptable")
})
test("real recorded promotion alternatives preserve their outcome freedom", () => {
  const f = RECORDED_CASES.find((f) => f.id === "pilot-draw-conversion")
  assert.ok(f?.engineReview)
  assert.equal(assessMove(f, "b2b1n").verdict, "acceptable") // +3.03, outside old near-best target.
  assert.equal(assessMove(f, "b2b1q").verdict, "acceptable")
  assert.equal(assessMove(f, "g8g7").verdict, "mistake") // Gives up the large advantage for repetition.
})

test("opening variety is not graded against one prescribed move", () => {
  const f = CASES.find((f) => f.id === "opening")
  assert.ok(f)
  for (const id of f.orders[0])
    assert.equal(assessMove(f, id).verdict, "ungraded")
})
