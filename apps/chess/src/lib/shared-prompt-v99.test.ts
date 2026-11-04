import assert from "node:assert/strict"
import test from "node:test"
import { CASES } from "../../bench/cases.ts"
import { fromFen, annotatedLegalMoves, currentThreats } from "./chess.ts"
import { buildSharedPrompt, CONCISE_PROMPT_VERSION, PREVIOUS_PROMPT_VERSION } from "./shared-prompt.ts"

function mirrorFen(fen: string): string {
  const fields = fen.split(" ")
  const swap = (letter: string) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
  fields[0] = fields[0].split("/").reverse().join("/").replace(/[a-z]/gi, swap)
  fields[1] = fields[1] === "b" ? "w" : "b"
  if (fields[2] !== "-") { const rights = fields[2].replace(/[kq]/gi, swap); fields[2] = [..."KQkq"].filter(right => rights.includes(right)).join("") }
  if (fields[3] !== "-") fields[3] = fields[3][0] + (9 - Number(fields[3][1]))
  return fields.join(" ")
}
const numericFacts = (text: string) => text
  .replace(/\b(pawn|knight|bishop|rook|queen) \((?:1|3|5|9)\)/g, "$1")
  .replace(/\b[a-h][1-8]\b/g, "square")
  .match(/[+-]?\d+/g) ?? []

test("v99 preserves decoded position, FEN state, legal labels, numeric outcomes and player ownership", () => {
  for (const fixture of CASES) for (const humanColor of ["white", "black"] as const) {
    const game = fromFen(humanColor === "black" ? mirrorFen(fixture.fen) : fixture.fen, humanColor)
    assert.equal(game.turn, "ai")
    const moves = annotatedLegalMoves(game, { relationships: true, mobility: true, support: true, castling: true, kingCover: true, promotionReplies: true, kingMobility: true, safety: true }).reverse()
    const frame = { game, moves, currentThreats: currentThreats(game) }
    const snapshot = structuredClone(frame)
    const before = buildSharedPrompt(frame, PREVIOUS_PROMPT_VERSION)
    const after = buildSharedPrompt(frame, CONCISE_PROMPT_VERSION)
    assert.deepEqual(after.choices.map(({ id, label, notation }) => ({ id, label, notation })), before.choices.map(({ id, label, notation }) => ({ id, label, notation })), fixture.id)
    const board = (text: string, end: string) => text.slice(text.indexOf("Your pieces ("), text.indexOf(end))
    assert.equal(board(after.prompt, "FEN state"), board(before.prompt, "Position FEN:"), fixture.id)
    assert.ok(after.prompt.includes(`FEN state (turn/castling/en-passant/halfmove/fullmove): ${game.fen.split(" ").slice(1).join(" ")}`))
    for (const [index, choice] of after.choices.entries()) {
      assert.deepEqual(numericFacts(choice.outcome), numericFacts(before.choices[index].outcome), `${fixture.id}: ${choice.id}`)
      assert.ok(after.prompt.includes(choice.outcome))
      assert.ok(choice.outcome.startsWith(choice.label + " | "))
    }
    assert.match(after.systemPrompt, /chess pieces/)
    assert.match(after.systemPrompt, /independent outcomes after your action, not history/)
    assert.match(after.systemPrompt, /Opponent replies next/)
    assert.match(after.systemPrompt, /negative means your loss/)
    assert.match(after.systemPrompt, /Do not count captures twice/)
    assert.match(after.systemPrompt, /check alone cannot justify material loss/)
    assert.match(after.systemPrompt, /Protection is not immunity/)
    assert.match(after.systemPrompt, /pawn 1, knight\/bishop 3, rook 5, queen 9/)
    assert.deepEqual(frame, snapshot)
    assert.deepEqual(buildSharedPrompt(frame, PREVIOUS_PROMPT_VERSION), before)
  }
})
