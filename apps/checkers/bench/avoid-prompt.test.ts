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
test("v20 and v21 add only the SOUND CHOICES line and its instruction to v19", () => {
  for (const version of ["shared-v20", "shared-v21"] as const) for (const { fixture, game, moves, annotated } of positions()) {
    const snapshot = structuredClone({ game, annotated })
    const before = buildSharedPrompt(game, annotated, "shared-v19")
    const after = buildSharedPrompt(game, annotated, version)
    const avoid = new Set(avoidableLosses(annotated, version === "shared-v21").map(move => move.id))
    assert.equal(after.version, version)
    assert.equal(after.outcomeVersion, before.outcomeVersion)
    assert.deepEqual(buildMovePrompt(game, moves, version), after, "the same analysis options")
    if (version === "shared-v21") assert.deepEqual(buildMovePrompt(game, moves), after, "production selects v21")
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

test("v21 keeps in only one-point slips that Human has no immediate capture to collect", () => {
  let kept = 0, stillOut = 0
  for (const { fixture, annotated } of positions()) {
    const strict = avoidableLosses(annotated), narrow = new Set(avoidableLosses(annotated, true))
    for (const move of narrow) assert.ok(strict.includes(move), `${fixture.id}: ${move.id} is left out by v20 too`)
    const listed = annotated.filter(move => !strict.includes(move) && move.outcome.status === "playing" && !move.outcome.forcesWinNextTurn && !move.outcome.forcesWinWithinFourTurns)
    for (const move of strict) {
      const id = `${fixture.id}: ${move.id}`
      if (narrow.has(move)) { stillOut++; continue }
      kept++
      assert.ok(!losesGame(move), `${id} does not lose the game`)
      assert.equal(net(move), Math.max(...listed.map(net)) - 1, `${id} is one point below the best`)
      assert.ok(!move.outcome.redReplies.some(reply => reply.captures.length > 0 && reply.netAfterBestResponse === net(move)), `${id}: no capture collects the point`)
    }
  }
  assert.ok(kept > 0 && stillOut > 0, "the suite exercises both sides of the narrower guard")
})

test("a hidden slip is one point, collected by a quiet reply", () => {
  const reply = (captures: number, netAfterBestResponse: number) => ({ captures: Array.from({ length: captures }, () => ({ square: 0, king: false, value: 1 })), netAfterBestResponse })
  const move = (id: string, outcome: Partial<AnnotatedMove["outcome"]>) => ({ id, outcome: { status: "playing", allowsRedWin: false, worstNetAfterResponse: 0, redReplies: [], ...outcome } }) as AnnotatedMove
  const ids = (moves: AnnotatedMove[]) => avoidableLosses(moves, true).map(item => item.id)
  const best = move("best", {})
  assert.deepEqual(ids([best, move("trap", { worstNetAfterResponse: -1, redReplies: [reply(0, -1), reply(1, 0)] as never })]), [], "a quiet reply wins the piece: Human has to find it")
  assert.deepEqual(ids([best, move("hang", { worstNetAfterResponse: -1, redReplies: [reply(1, -1)] as never })]), ["hang"], "a capture wins it at once")
  assert.deepEqual(ids([best, move("two", { worstNetAfterResponse: -2, redReplies: [reply(0, -2)] as never })]), ["two"], "two points is a blunder however it is collected")
  assert.deepEqual(ids([best, move("fatal", { allowsRedWin: true, worstNetAfterResponse: -1, redReplies: [reply(0, -1)] as never })]), ["fatal"], "losing the game is never a slip")
  assert.deepEqual(ids([move("gain", { worstNetAfterResponse: 1 }), move("quiet", { redReplies: [reply(0, 0)] as never })]), [], "a gain not taken is the model's to judge")
})
