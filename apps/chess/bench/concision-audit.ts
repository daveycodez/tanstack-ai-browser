/** Manual, model-free proof that concise presentation preserves factual move data. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CASES } from "./cases.ts"
import type { BenchmarkReport } from "./types.ts"
import { annotatedLegalMoves, applyMove, currentThreats, fromFen, newGame } from "../src/lib/chess.ts"
import { buildSharedPrompt } from "../src/lib/shared-prompt.ts"
import { stableMoveOrder } from "../src/lib/move-order.ts"
import { moveOutputSchema } from "../src/lib/move-output.ts"

const baseline = JSON.parse(readFileSync(new URL("./results/2026-11-02-100-latest-lfm-full.json", import.meta.url), "utf8")) as BenchmarkReport
const boardRows = (prompt: string) => prompt.split("\n")
  .filter(line => /^(Black pieces|White pieces|King:|Queens:|Rooks:|Bishops:|Knights:|Pawns:)/.test(line))
  .map(line => line.replace(" (you)", "").replace(" (opponent)", ""))
const threats = (prompt: string) => prompt.split("\n")
  .filter(line => line.startsWith("Black ") && line.includes("can be captured by White"))
  .map(line => line.replace(/ \((?:royal|\d+)\) on /g, " "))
function history(prompt: string) {
  const lines = prompt.split("\n"), start = lines.indexOf("Recent 8 moves (oldest first):")
  assert.ok(start >= 0)
  const end = lines.findIndex((line, i) => i > start && line.startsWith("ALL LEGAL CARDS"))
  assert.ok(end > start)
  return lines.slice(start + 1, end)
}
const summaries = [
  ["KING-SAFE CHOICES", "KING-SAFE CHOICES"],
  ["Black can RESCUE AN ATTACKED QUEEN", "Black can RESCUE AN ATTACKED QUEEN"],
  ["MATERIAL-SAFE CHOICES", "MATERIAL-SAFE CHOICES"],
  ["Black can WIN THIS TURN", "Black can WIN THIS TURN"],
  ["Available captures with", "Available captures with"],
  ["Legal castling moves now:", "Legal castles now:"],
  ["Castling preference applies to:", "Prefer these castles over"]
] as const
const cardFacts = (outcome: string) => { const fields = outcome.split(" | "); return fields.slice(fields[2]?.startsWith("UCI ") ? 4 : 2).join(" | ") }
let cards = 0
const visited = new Set<string>()
for (const old of baseline.results) {
  const fixture = CASES.find(item => item.id === old.caseId)
  assert.ok(fixture)
  const game = fixture.history ? fixture.history.reduce(applyMove, newGame()) : fromFen(fixture.fen)
  assert.equal(game.fen, old.fen)
  const moves = stableMoveOrder(annotatedLegalMoves(game, {
    relationships: true, mobility: true,
    support: game.board.some(piece => piece?.side === game.turn && (piece.type === "q" || piece.type === "r")),
    castling: /[kq]/.test(game.fen.split(" ")[2]),
    kingCover: true, promotionReplies: true, kingMobility: true, safety: true
  }), `${baseline.config.moveOrderSeed}:${old.repetition}`)
  const result = buildSharedPrompt({ game, moves, currentThreats: currentThreats(game) })
  assert.deepEqual(result.choices.map(({id,notation,label}) => ({id,notation,label})), old.choices.map(({id,notation,label}) => ({id,notation,label})))
  assert.deepEqual(moveOutputSchema(result.choices.map(choice => choice.label)).shape.move.options, old.choices.map(choice => choice.label))
  for (let i = 0; i < result.choices.length; i++) {
    const compact = result.choices[i], previous = old.choices[i]
    assert.equal(cardFacts(compact.outcome), cardFacts(previous.outcome), `${old.caseId}: ${compact.id} facts`)
    cards++
  }
  assert.ok(old.prompt)
  assert.deepEqual(boardRows(result.prompt), boardRows(old.prompt))
  assert.deepEqual(threats(result.prompt), threats(old.prompt))
  assert.deepEqual(history(result.prompt), history(old.prompt))
  assert.equal(result.prompt.split("\n").find(line => line.startsWith("Black in check:")), old.prompt.split("\n").find(line => line.startsWith("Black in check:")))
  for (const [before, after] of summaries) {
    const original: string | undefined = old.prompt.split("\n").find(line => line.startsWith(before))
    const concise: string | undefined = result.prompt.split("\n").find(line => line.startsWith(after)) ?? result.prompt.split("\n").find(line => line.startsWith(before))
    assert.equal(Boolean(concise), Boolean(original), `${old.caseId}: ${before} presence`)
    assert.deepEqual(result.choices.filter(choice => concise?.includes(choice.label)).map(choice => choice.id), old.choices.filter(choice => choice.label && original?.includes(choice.label)).map(choice => choice.id), `${old.caseId}: ${before} membership/order`)
  }
  visited.add(old.caseId)
}
console.log(JSON.stringify({positions:visited.size, trials:baseline.results.length, comparedCards:cards, preserved:["all legal IDs/order", "exact action enums", "SAN audit metadata", "byte-identical consequence/context facts", "named-piece board", "current threats/check", "recent history", "safety/winning/capture/castling memberships"]}, null, 2))
