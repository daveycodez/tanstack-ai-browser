import assert from "node:assert/strict"
import test from "node:test"
import { CASES, gameForCase } from "./cases.ts"
import { legalMoves } from "../src/lib/checkers.ts"
import { annotateMoves } from "../src/lib/move-outcomes.ts"
import { buildMovePrompt, buildSharedPrompt } from "../src/lib/shared-prompt.ts"

// Every recorded position and both player colors; no scored expectations change.
test("v19 preserves v18 analysis inputs, legal actions, response labels and numerical facts", () => {
  const numbers = (text: string) => text.replace(/Material: AI \d+ pieces; Human \d+ pieces; balance ([+-]?\d+) points\./, "AI balance $1 points.").match(/\d+/g) ?? []
  for (const fixture of CASES) for (const humanColor of ["white", "black"] as const) {
    const game = { ...gameForCase(fixture), humanColor }
    const moves = legalMoves(game.board, "ai").reverse()
    const annotated = annotateMoves(game, moves, true, true)
    const snapshot = structuredClone({ game, annotated })
    const before = buildSharedPrompt(game, annotated, "shared-v18")
    const after = buildSharedPrompt(game, annotated, "shared-v19")
    assert.equal(after.outcomeVersion, before.outcomeVersion)
    assert.match(after.systemPrompt, /legal checkers action as AI against Human/)
    assert.match(after.systemPrompt, /Human replies after each AI action/)
    assert.deepEqual(buildMovePrompt(game, moves, "shared-v19"), after, "production selects exactly the same analysis options")
    assert.deepEqual(numbers(after.prompt), numbers(before.prompt), fixture.id)
    assert.equal(after.prompt.includes("Near-crown runners/capture-recapture trades add one Human/AI pair."), annotated.some(move => move.outcome.redTurnsChecked === 2))
    assert.match(after.systemPrompt, /counts this move, every Human reply and best AI response, then forced captures until a turn has no capture or game end/)
    assert.match(after.systemPrompt, /If every exchange loses material, prefer smallest loss/)
    assert.match(after.systemPrompt, /Avoid draws ahead; prefer a draw behind unless a listed win exists/)
    assert.match(after.systemPrompt, /Both optimize material; net shows worst Human reply, not a positional-win proof/)
    assert.equal(after.systemPrompt.includes("King distance: diagonal steps to nearest Human"), before.choices.some(choice => choice.outcome.includes("King distance to nearest Human")))
    assert.deepEqual(after.choices.map(({ id, label }) => ({ id, label })), before.choices.map(({ id, label }) => ({ id, label })), fixture.id)
    for (const [index, choice] of after.choices.entries()) {
      assert.deepEqual(numbers(choice.outcome), numbers(before.choices[index].outcome), `${fixture.id}: ${choice.id}`)
      assert.ok(after.prompt.includes(choice.outcome))
      const previous = before.choices[index].outcome
      const exchange = previous.match(/Checked exchange net: AI (gains|loses) (\d+) points/)
      if (exchange) assert.ok(choice.outcome.includes(`AI ${exchange[1]} ${exchange[2]}`))
      if (previous.includes("AI breaks even at 0 points")) assert.ok(choice.outcome.includes("AI breaks even at 0 points"))
      assert.equal(choice.outcome.includes("Human can claim a draw next"), previous.includes("Human can claim an immediate draw"))
      assert.equal((choice.outcome.includes("no Human win next") || choice.outcome.includes("no Human win or capture next")), previous.includes("No immediate Human win"))
      assert.equal((choice.outcome.includes("no Human capture next") || choice.outcome.includes("no Human win or capture next")), previous.includes("Human has no immediate legal capture"))
      const witness = previous.match(/Worst checked exchange: (.*?); net AI/)
      if (witness) assert.ok(choice.outcome.includes(`worst: ${witness[1]}`))
    }
    for (const move of game.history.slice(-5)) assert.ok(after.prompt.includes(move.notation))
    assert.doesNotMatch(after.systemPrompt + after.prompt, /RECOMMENDED|CHECKED PRIORITY|JSON Schema|Return only JSON/)
    assert.ok(after.systemPrompt.length < before.systemPrompt.length)
    assert.ok(after.prompt.length < before.prompt.length)
    assert.deepEqual({ game, annotated }, snapshot)
    assert.deepEqual(buildSharedPrompt(game, annotated, "shared-v18"), before)
  }
})
