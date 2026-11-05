import assert from "node:assert/strict"
import test from "node:test"
import { buildMovePrompt, CONCISE_PROMPT_VERSION } from "./shared-prompt.ts"
import { buildMovePrompt as buildV16 } from "./shared-prompt-v16.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
import { legalMoves } from "./mancala.ts"
import { createEndgameTieRequest } from "./endgame-ties.ts"

const analysis = (input: object) => Object.fromEntries(Object.entries(input).filter(([key]) => !["version", "systemPrompt", "prompt", "choices"].includes(key)))
const numbers = (text: string) => text.match(/[+-]?\d+/g) ?? []

test("v17 preserves every v16 action's numbers, proof status, horizon and independent analysis", () => {
  for (const fixture of CASES) for (const reversed of [false, true]) {
    const game = gameForCase(fixture), snapshot = structuredClone(game)
    const moves = legalMoves(game.board, "ai"); if (reversed) moves.reverse()
    const request = createEndgameTieRequest()
    const before = buildV16(game, moves, undefined, request.solve)
    const after = buildMovePrompt(game, moves, CONCISE_PROMPT_VERSION, request.solve)
    assert.deepEqual(after.choices.map(choice => [choice.id, choice.label]), before.choices.map(choice => [choice.id, choice.label]), fixture.id)
    for (const [index, choice] of after.choices.entries()) {
      const old = before.choices[index].outcome
      assert.deepEqual(numbers(choice.outcome), numbers(old), `${fixture.id}: ${choice.id}`)
      assert.ok(choice.outcome.startsWith(choice.label + " | "))
      assert.ok(after.prompt.includes(choice.outcome))
      const now = old.match(/capture now (\d+); store gain now (\d+); bonus (yes|no)/)
      assert.ok(now)
      assert.ok(choice.outcome.includes(`capture ${now[1]}; store gain ${now[2]}; bonus ${now[3]}`))
      const reply = old.match(/opponent capture exposure (\d+|unknown); AI-defeat reply exists (yes|no|unknown)/)
      if (reply) assert.ok(choice.outcome.includes(`opponent capture exposure ${reply[1]}; AI-defeat reply exists ${reply[2]}`))
      const bounded = old.match(/(\d+) complete turns, AI margin ([+-]?\d+) \(bounded\)/)
      if (bounded) assert.ok(choice.outcome.includes(bounded[0]))
      const result = old.split(" | ")[1]
      assert.equal(choice.outcome.split(" | ")[1], result)
    }
    assert.deepEqual(analysis(after), analysis(before), fixture.id)
    assert.doesNotMatch(after.systemPrompt + after.prompt + JSON.stringify(after.report), /recommended|preferred|\| (?:BEST|OTHER) \|/i)
    assert.match(after.systemPrompt, /Bonus sows belong to the same complete turn/)
    assert.match(after.systemPrompt, /evaluation kind and horizon match/)
    assert.match(after.systemPrompt, /Incomplete analysis is unknown/)
    assert.match(after.systemPrompt, /best play by both sides/)
    assert.deepEqual(game, snapshot)
  }
})
