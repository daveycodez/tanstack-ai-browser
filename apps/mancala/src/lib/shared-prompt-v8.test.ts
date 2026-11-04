import assert from "node:assert/strict"
import test from "node:test"
import { createGame } from "./mancala.ts"
import { buildMovePrompt, SHARED_SYSTEM_PROMPT } from "./shared-prompt-v8.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
const position = (board: number[]) => ({
  ...createGame(),
  turn: "ai" as const,
  board
})
test("state is data-only and exposes one preferred list with AI-relative capture risk", () => {
  const input = buildMovePrompt(
    position([0, 0, 4, 1, 10, 1, 6, 1, 0, 3, 10, 1, 8, 3])
  )
  const report = input.report
  assert.ok(report)
  assert.deepEqual(JSON.parse(input.prompt), report)
  assert.equal(report.you, "AI")
  assert.equal(report.opponent, "Human")
  assert.deepEqual(report.preferredActions, ["Sow 1 seed from AI pit 1"])
  const best = report.actions.find((a) => a.preferred),
    bad = report.actions.find((a) => a.label === "Sow 1 seed from AI pit 5")
  assert.ok(best && bad)
  assert.equal(best.evaluation.marginForAI, 4)
  assert.equal(bad.evaluation.marginForAI, -20)
  assert.equal(bad.evaluation.marginBelowBest, 24)
  assert.equal(bad.opponentReply?.captureTotal, 12)
  assert.equal(bad.opponentReply?.witness?.aiSeedsStolen, 11)
  assert.ok(!input.prompt.includes("CHECKED PRIORITY ACTIONS"))
  assert.ok(!input.prompt.includes("Return only JSON"))
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /A legal action in the JSON schema is not necessarily a good action/
  )
})
test("an opponent win is labeled as AI LOSS even when no capture is available", () => {
  const input = buildMovePrompt(
    position([0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16])
  )
  const bad = input.report?.actions.find(
    (a) => a.label === "Sow 1 seed from AI pit 3"
  )
  assert.ok(bad)
  assert.equal(bad.resultForAI, "LOSS")
  assert.equal(bad.evaluation.marginForAI, -4)
  assert.equal(bad.opponentReply?.captureTotal, 0)
  assert.equal(bad.opponentReply?.canWin, true)
  assert.ok(!input.report?.preferredActions.includes(bad.label))
  assert.ok(
    input.report?.actions.some((a) => a.preferred && a.resultForAI === "DRAW")
  )
})
test("full-suite data repackaging preserves evaluations, priorities and every legal schema label", () => {
  for (const fixture of CASES) {
    const game = gameForCase(fixture),
      old = buildMovePrompt(game, undefined, "shared-v7"),
      current = buildMovePrompt(game)
    assert.deepEqual(current.analysis, old.analysis, fixture.id)
    assert.deepEqual(current.endgame, old.endgame, fixture.id)
    assert.deepEqual(current.priorityPits, old.priorityPits, fixture.id)
    assert.deepEqual(
      current.choices.map((c) => [c.id, c.label]),
      old.choices.map((c) => [c.id, c.label]),
      fixture.id
    )
  }
})
