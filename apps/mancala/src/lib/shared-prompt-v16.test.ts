import assert from "node:assert/strict"
import test from "node:test"
import { buildMovePrompt, PROMPT_VERSIONS, SHARED_PROMPT_VERSION } from "./shared-prompt.ts"
import { buildMovePrompt as buildV15 } from "./shared-prompt-v15.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"
import { createGame, legalMoves } from "./mancala.ts"

const rankingKeys = new Set(["preferred", "preferredActions", "marginBelowBest", "aiSeedsBelowBest", "evaluationScope"])
function factsOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(factsOnly)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !rankingKeys.has(key)).map(([key, value]) => [key, factsOnly(value)]))
  return value
}
const recommendation = /recommended|preferred|below best|CHECKED PRIORITY|\| (?:BEST|OTHER) \|/i

test("v16 gives the model every factual move outcome without recommendations for all 23 cases and both orders", () => {
  assert.equal(SHARED_PROMPT_VERSION, "shared-v16")
  assert.deepEqual(PROMPT_VERSIONS.slice(-2), ["shared-v15", "shared-v16"])
  assert.equal(CASES.length, 23)
  const proofKinds = new Set<string>()
  for (const fixture of CASES) for (const reverse of [false, true]) {
    const game = gameForCase(fixture), original = structuredClone(game)
    const moves = legalMoves(game.board, "ai"); if (reverse) moves.reverse()
    const request = createEndgameTieRequest()
    const before = buildV15(game, moves, undefined, request.solve)
    const after = buildMovePrompt(game, moves, undefined, request.solve)
    assert.equal(after.version, "shared-v16")
    assert.doesNotMatch(after.systemPrompt + after.prompt + JSON.stringify(after.choices) + JSON.stringify(after.report), recommendation, fixture.id)
    assert.equal("recommendedAction" in after, false); assert.equal("priorityPits" in after, false)
    assert.deepEqual(after.choices.map(c => ({ id: c.id, label: c.label })), before.choices.map(c => ({ id: c.id, label: c.label })), fixture.id)
    assert.deepEqual(after.choices.map(c => c.id), moves)
    assert.deepEqual(after.analysis, before.analysis, fixture.id)
    assert.deepEqual(after.report, factsOnly(before.report), fixture.id)
    assert.deepEqual(after.finalComparison, before.finalComparison, fixture.id)
    assert.deepEqual(after.outcomeComparison, before.outcomeComparison, fixture.id)
    for (const action of after.report?.actions ?? []) proofKinds.add(action.evaluation.kind)
    for (const choice of after.choices) {
      assert.ok(after.prompt.includes(choice.outcome), fixture.id)
      const old = before.choices.find(c => c.id === choice.id); assert.ok(old)
      // Model-visible facts change only by deleting rank labels, relative ranks, and the tie-review stamp.
      assert.equal(choice.outcome, old.outcome.replace(/ \| (BEST|OTHER) \| /g, " | ").replace(/; final AI seeds below best(?: compared)? finish \d+/g, "").replace(" | TIE REVIEW: ", " | "))
    }
    assert.deepEqual(game, original)
  }
  assert.ok(proofKinds.has("BOUNDED_TURNS")); assert.ok(proofKinds.has("EXACT_ENDGAME")); assert.ok(proofKinds.has("FINAL_NOW"))
})

test("full-game proof and incomplete-analysis paths remain factual, never selected answers", () => {
  const board = [0, 0, 1, 9, 1, 1, 16, 0, 0, 1, 2, 9, 0, 8]
  const game = { ...createGame(), turn: "ai" as const, board }
  const input = buildMovePrompt(game)
  assert.equal(input.outcomeComparison?.complete, true)
  assert.match(input.choices.find(c => c.id === 10)!.outcome, /PROVED WIN FOR YOU/)
  assert.ok(input.choices.some(c => /PROVED (DRAW|DEFEAT)/.test(c.outcome)))
  assert.doesNotMatch(input.systemPrompt + input.prompt, recommendation)
  assert.equal("recommendedAction" in input, false)
  // A bounded/incomplete endgame review must not become an unconditional proof claim.
  const opening = { ...createGame(), turn: "ai" as const }
  const request = createEndgameTieRequest()
  const before = buildV15(opening, undefined, undefined, request.solve)
  const after = buildMovePrompt(opening, undefined, undefined, request.solve)
  assert.deepEqual(after.analysis, before.analysis)
  assert.doesNotMatch(after.prompt, /Every legal action has a proved AI outcome/)
  assert.doesNotMatch(after.prompt, recommendation)
})

test("historical v15 remains directly selectable without changing its prompts or recommendation metadata", () => {
  const game = { ...createGame(), turn: "ai" as const }, request = createEndgameTieRequest()
  assert.deepEqual(buildMovePrompt(game, undefined, "shared-v15", request.solve), buildV15(game, undefined, "shared-v15", request.solve))
})
