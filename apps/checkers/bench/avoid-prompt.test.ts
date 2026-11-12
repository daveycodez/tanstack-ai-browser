import assert from "node:assert/strict"
import test from "node:test"
import { CASES, gameForCase } from "./cases.ts"
import { legalMoves } from "../src/lib/checkers.ts"
import { annotateMoves } from "../src/lib/move-outcomes.ts"
import type { AnnotatedMove } from "../src/lib/move-outcomes.ts"
import { SOUND_INSTRUCTION, avoidableLosses, buildMovePrompt, buildSharedPrompt, checkedPriorityChoices } from "../src/lib/shared-prompt.ts"

const positions = () => CASES.flatMap(fixture => (["white", "black"] as const).map(humanColor => {
  const game = { ...gameForCase(fixture), humanColor }
  const moves = legalMoves(game.board, "ai")
  if (humanColor === "black") moves.reverse()
  return { fixture, game, moves, annotated: annotateMoves(game, moves, true, true) }
}))
const losesGame = (move: AnnotatedMove) => move.outcome.allowsRedWin || move.outcome.allowsCheckedLoss === true
const net = (move: AnnotatedMove) => move.outcome.worstNetAfterResponse

// Every recorded position and both player colors.
test("v20 adds only the SOUND CHOICES line and its instruction to v19", () => {
  for (const { fixture, game, moves, annotated } of positions()) {
    const snapshot = structuredClone({ game, annotated })
    const before = buildSharedPrompt(game, annotated, "shared-v19")
    const after = buildSharedPrompt(game, annotated, "shared-v20")
    const avoid = new Set(avoidableLosses(annotated).map(move => move.id))
    assert.equal(after.version, "shared-v20")
    assert.equal(after.outcomeVersion, before.outcomeVersion)
    assert.deepEqual(buildMovePrompt(game, moves), after, "production selects v20 with the same analysis options")
    assert.equal(after.systemPrompt.split("\n")[1], SOUND_INSTRUCTION, "the instruction is constant, so the system prompt's start stays cacheable")
    assert.equal(after.systemPrompt.split("\n").filter(line => line !== SOUND_INSTRUCTION).join("\n"), before.systemPrompt, fixture.id)
    assert.deepEqual(after.choices, before.choices, fixture.id)
    assert.deepEqual(after.choices.map(choice => choice.id), moves.map(move => move.id))
    const lines = after.prompt.split("\n"), listed = lines.filter(line => line.startsWith("SOUND CHOICES: "))
    if (avoid.size) {
      assert.equal(lines.at(-1), `SOUND CHOICES: ${after.choices.filter(choice => !avoid.has(choice.id)).map(choice => choice.label).join("; ")}.`, fixture.id)
      assert.equal(listed.length, 1, fixture.id)
      assert.equal(lines.slice(0, -1).join("\n"), before.prompt, fixture.id)
    } else assert.equal(after.prompt, before.prompt, `${fixture.id}: nothing is listed when no action is worse`)
    assert.doesNotMatch(after.systemPrompt + after.prompt, /RECOMMENDED|CHECKED PRIORITY|AVOID/)
    assert.deepEqual({ game, annotated }, snapshot)
  }
})

test("a left-out action loses the game or has a lower checked net than a listed action", () => {
  let marked = 0
  for (const { fixture, annotated } of positions()) {
    const avoid = new Set(avoidableLosses(annotated))
    const kept = annotated.filter(move => !avoid.has(move))
    marked += avoid.size
    assert.ok(kept.length > 0, `${fixture.id}: an action always remains`)
    const keptPlaying = kept.filter(move => move.outcome.status === "playing" && !move.outcome.forcesWinNextTurn && !move.outcome.forcesWinWithinFourTurns)
    for (const move of avoid) {
      const id = `${fixture.id}: ${move.id}`
      assert.equal(move.outcome.status, "playing", id)
      assert.ok(!move.outcome.forcesWinNextTurn && !move.outcome.forcesWinWithinFourTurns, id)
      const safer = kept.some(other => !losesGame(other))
      const cheaper = keptPlaying.some(other => net(other) > net(move))
      // When every action loses the game, material still separates them.
      assert.ok(losesGame(move) ? safer || cheaper : cheaper, id)
    }
    // Nothing is ranked among the rest: equal checked results are kept or marked together.
    assert.ok(new Set(keptPlaying.map(net)).size <= 1, `${fixture.id}: the remaining actions tie on checked net`)
  }
  assert.ok(marked > 0, "the suite exercises the guard")
})

test("the guard is wider than v17's recommendations and never marks one of them", () => {
  let narrowed = 0, single = 0, formerlySingle = 0
  for (const { fixture, game, annotated } of positions()) {
    if (annotated.length < 2) continue
    const avoid = new Set(avoidableLosses(annotated).map(move => move.id))
    const priority = checkedPriorityChoices(game, annotated)
    for (const move of priority) assert.ok(!avoid.has(move.id), `${fixture.id}: ${move.id}`)
    assert.ok(annotated.length - avoid.size >= priority.length, fixture.id)
    if (annotated.length - avoid.size > priority.length) narrowed++
    if (annotated.length - avoid.size === 1) single++
    if (priority.length === 1) formerlySingle++
  }
  assert.ok(narrowed > 0, "some positions leave the model more than v17 recommended")
  assert.ok(single < formerlySingle, "fewer positions have a single remaining action than v17 had a single recommendation")
})

test("an unavoidable loss, an immediate result and a forced win are left unmarked", () => {
  const move = (id: string, outcome: Partial<AnnotatedMove["outcome"]>) => ({ id, outcome: { status: "playing", allowsRedWin: false, worstNetAfterResponse: 0, ...outcome } }) as AnnotatedMove
  const ids = (moves: AnnotatedMove[]) => avoidableLosses(moves).map(item => item.id)
  assert.deepEqual(ids([move("a", {}), move("b", { worstNetAfterResponse: 1 }), move("c", { worstNetAfterResponse: -1 })]), ["a", "c"], "a free gain is not passed over")
  assert.deepEqual(ids([move("a", {}), move("b", {}), move("c", {})]), [], "a quiet position stays open")
  assert.deepEqual(ids([move("a", { worstNetAfterResponse: -1 }), move("b", { worstNetAfterResponse: -1 }), move("c", { worstNetAfterResponse: -2 })]), ["c"], "the smallest loss stays")
  assert.deepEqual(ids([move("a", { allowsRedWin: true, worstNetAfterResponse: 2 }), move("b", { worstNetAfterResponse: -1 })]), ["a"], "survival comes before material")
  assert.deepEqual(ids([move("a", { allowsRedWin: true }), move("b", { allowsCheckedLoss: true })]), [], "nothing to prefer when every action loses")
  assert.deepEqual(ids([move("a", { allowsRedWin: true }), move("b", { status: "draw" })]), ["a"], "a draw is the way out")
  assert.deepEqual(ids([move("a", {}), move("b", { status: "ai-won", worstNetAfterResponse: -5 }), move("c", { forcesWinNextTurn: true, worstNetAfterResponse: -1 }), move("d", { forcesWinWithinFourTurns: true, worstNetAfterResponse: -1 })]), [])
})
