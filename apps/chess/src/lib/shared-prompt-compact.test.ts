import assert from "node:assert/strict"
import test from "node:test"
import { CASES } from "../../bench/cases.ts"
import { RECORDED_CASES } from "../../bench/recorded-cases.ts"
import { applyMove, fromFen, newGame } from "./chess.ts"
import type { Game } from "./chess.ts"
import { buildMoveAnalysis } from "./move-analysis.ts"
import { COMPACT_PROMPT_VERSION, SHARED_PROMPT_VERSION, TACTICAL_PROMPT_VERSION, systemPromptFor } from "./shared-prompt.ts"

// (A square also ends a SAN move, as in exf5.)
const squares = (text: string) => [...new Set(text.match(/[a-h][1-8]/g) ?? [])].sort()
const numbers = (text: string) => [...new Set(text.replace(/[a-h][1-8]/g, "").match(/-?\d+/g) ?? [])].sort()
const board = (prompt: string) => prompt.slice(prompt.indexOf("Your pieces ("), prompt.indexOf("Turn: "))

function games(): Array<{ id: string; game: Game }> {
  const fixtures = CASES.flatMap((fixture) => {
    const game = fromFen(fixture.fen, "white")
    return game.turn === "ai" && game.status === "playing" ? [{ id: fixture.id, game }] : []
  })
  const recorded = RECORDED_CASES.flatMap((fixture) =>
    fixture.history ? [{ id: fixture.id, game: fixture.history.reduce(applyMove, newGame(fixture.humanColor)) }] : []
  )
  return [...fixtures, ...recorded]
}

test("the compact prompt is the default and keeps every move, label, order, square and net of the tactical one", () => {
  assert.equal(SHARED_PROMPT_VERSION, COMPACT_PROMPT_VERSION)
  const all = games()
  assert.ok(all.length > 20)
  let before = 0, after = 0
  for (const { id, game } of all) {
    const saved = structuredClone(game)
    const tactical = buildMoveAnalysis({ game, promptVersion: TACTICAL_PROMPT_VERSION })
    const compact = buildMoveAnalysis({ game })
    assert.deepEqual(
      compact.choices.map(({ id, label, notation }) => ({ id, label, notation })),
      tactical.choices.map(({ id, label, notation }) => ({ id, label, notation })),
      id
    )
    assert.equal(board(compact.prompt), board(tactical.prompt), id)
    for (const [index, choice] of compact.choices.entries()) {
      const card = tactical.choices[index].outcome
      assert.ok(choice.outcome.startsWith(choice.label + " | "), `${id}: ${choice.id}`)
      assert.ok(compact.prompt.split("\n").includes(choice.outcome), `${id}: ${choice.id}`)
      assert.deepEqual(squares(choice.outcome), squares(card), `${id}: ${choice.id}`)
      assert.deepEqual(numbers(choice.outcome), numbers(card), `${id}: ${choice.id}`)
      assert.ok(choice.outcome.length <= card.length, `${id}: ${choice.id}`)
    }
    assert.equal(compact.systemPrompt, systemPromptFor(game))
    assert.deepEqual(game, saved)
    before += tactical.prompt.length + tactical.systemPrompt.length
    after += compact.prompt.length + compact.systemPrompt.length
  }
  // Fewer words, not fewer facts: at least a quarter shorter over the suite.
  assert.ok(after < before * 0.75, `${after} of ${before}`)
})

test("the compact system prompt keeps the tactical one's rules for either side", () => {
  for (const humanColor of ["white", "black"] as const) {
    const system = systemPromptFor({ humanColor })
    assert.match(system, humanColor === "white" ? /^You control the dark chess pieces\./ : /^You control the light chess pieces\./)
    for (const rule of [
      /Take a listed CHECKMATE now/,
      /LOSE NEXT TURN/,
      /independent outcomes after your action, not history/,
      /Opponent replies next/,
      /negative means your loss/,
      /check alone cannot justify material loss/,
      /Protection is not immunity/,
      /pawn 1, knight\/bishop 3, rook 5, queen 9/,
      /never add their nets/,
      /not a whole-position evaluation/
    ])
      assert.match(system, rule)
    assert.ok(system.length < systemPromptFor({ humanColor }, TACTICAL_PROMPT_VERSION).length)
  }
})

test("a one-capture exchange line is dropped only where its DANGER says the same capture and net", () => {
  const f = RECORDED_CASES.find((fixture) => fixture.id === "quiet-fork-king-rook")
  assert.ok(f?.history)
  const game = f.history.reduce(applyMove, newGame(f.humanColor))
  const tactical = buildMoveAnalysis({ game, promptVersion: TACTICAL_PROMPT_VERSION, moveOrder: f.orders[0] })
  const compact = buildMoveAnalysis({ game, moveOrder: f.orders[0] })
  // The longer lines stay, move for move.
  assert.ok(tactical.prompt.includes("opponent Nxb3, you cxb3, opponent Qxd5"))
  assert.ok(compact.prompt.includes("opponent Nxb3, you cxb3, opponent Qxd5"))
  assert.ok(compact.prompt.includes("opponent Nc2+, you Ke2, opponent Nxa1"))
  for (const [index, choice] of compact.choices.entries()) {
    const witness = /; CHECKED EXCHANGE net (-?\d+): opponent (\S+)(?=;|$)/.exec(tactical.choices[index].outcome)
    if (!witness || choice.outcome.includes(`EXCHANGE ${witness[1]}: opponent ${witness[2]}`)) continue
    const target = /([a-h][1-8])(?:=[QRBN])?[+#]?$/.exec(witness[2])?.[1]
    assert.match(choice.outcome, new RegExp(`DANGER: \\w+ [a-h][1-8] takes \\w+ ${target}, net ${witness[1]}`))
  }
})
