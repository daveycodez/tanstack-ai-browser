import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import {
  annotatedLegalMoves,
  applyMove,
  currentThreats,
  fromFen,
  newGame
} from "./chess.ts"
import { buildSharedPrompt, SHARED_PROMPT_VERSION } from "./shared-prompt.ts"
import type { SharedPromptInput } from "./shared-prompt.ts"

// Exact prompts recorded in the completed pre-refactor compact-highlights run.
const recorded = [
  {
    caseId: "mate-in-one",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
    order: [
      "d7d6",
      "a7a6",
      "d8h4",
      "d8f6",
      "g8f6",
      "g7g5",
      "f8b4",
      "f7f6",
      "h7h6",
      "d8g5",
      "c7c5",
      "b8c6",
      "g8e7",
      "d8e7",
      "b7b6",
      "d7d5",
      "e5e4",
      "g7g6",
      "f7f5",
      "e8e7",
      "c7c6",
      "h7h5",
      "f8a3",
      "f8c5",
      "g8h6",
      "a7a5",
      "f8e7",
      "b8a6",
      "b7b5",
      "f8d6"
    ],
    sha256: "e0cdbd023b703c7edbae58c6d0f8c11236331b25c4c514f016a1241fbd27b752"
  },
  {
    caseId: "free-queen",
    fen: "r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1",
    order: [
      "a8a2",
      "g8f8",
      "e5e4",
      "g7g6",
      "e5d4",
      "a8c8",
      "a8d8",
      "a8a7",
      "h7h6",
      "a8a3",
      "g8h8",
      "f7f5",
      "a8a6",
      "a8f8",
      "a8b8",
      "f7f6",
      "a8a5",
      "a8a1",
      "a8e8",
      "h7h5",
      "g7g5",
      "a8a4"
    ],
    sha256: "07c3f4d3e9e811344de22f26bbcf13853f3d9b1d237568d3a4f4b3d42198b012"
  },
  {
    caseId: "defended-trade",
    fen: "3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1",
    order: [
      "d8d4",
      "d8e8",
      "d8f8",
      "d8g8",
      "d8e7",
      "d8f6",
      "d8g5",
      "d8h4",
      "d8d7",
      "d8d6",
      "d8d5",
      "d8c7",
      "d8b6",
      "d8a5",
      "d8c8",
      "d8b8",
      "d8a8",
      "h8h7",
      "h8g7",
      "h8g8"
    ],
    sha256: "2e903f83541b12087c3ec83f8c7612b35f5195fd3d8cc948bc14ec795909a436"
  },
  {
    caseId: "castle-or-save-queen",
    fen: "r3k2r/5pp1/7p/3q4/4P3/8/5PPK/8 b kq - 0 1",
    order: [
      "a8a2",
      "d5b3",
      "a8a6",
      "h8f8",
      "d5d8",
      "e8d8",
      "d5a5",
      "d5d4",
      "g7g5",
      "d5d6",
      "h8h7",
      "d5d3",
      "a8d8",
      "d5b5",
      "e8d7",
      "d5e6",
      "d5e4",
      "f7f6",
      "e8f8",
      "d5c5",
      "f7f5",
      "d5b7",
      "d5d1",
      "d5d2",
      "d5g5",
      "d5c4",
      "a8b8",
      "h6h5",
      "d5h5",
      "d5a2",
      "g7g6",
      "d5d7",
      "a8a3",
      "d5f5",
      "h8g8",
      "a8a1",
      "d5e5",
      "a8a5",
      "e8c8",
      "e8g8",
      "d5c6",
      "a8a7",
      "e8e7",
      "a8c8",
      "a8a4"
    ],
    sha256: "ef91a09f3cc6cf996b3e40e115906ab73441b66dacd113d9506607a072c55b84"
  },
  {
    caseId: "context-castle-now",
    fen: "r3k2r/8/8/8/8/8/4K3/R6R b kq - 0 1",
    order: [
      "a8b8",
      "a8d8",
      "a8a7",
      "e8f7",
      "e8e7",
      "h8h5",
      "a8a4",
      "a8a2",
      "a8a5",
      "e8d8",
      "e8g8",
      "a8c8",
      "a8a6",
      "h8h3",
      "h8f8",
      "e8d7",
      "h8h6",
      "h8h4",
      "h8h2",
      "a8a1",
      "e8c8",
      "h8g8",
      "h8h7",
      "h8h1",
      "e8f8",
      "a8a3"
    ],
    sha256: "15436424fbbf2a8e6caf762c84b474e6cf71c188f3c9fafc9c66d445cbd202d2"
  }
] as const

function fixtureInput(fixture: (typeof recorded)[number]): SharedPromptInput {
  const game = fromFen(fixture.fen)
  const byId = new Map(
    annotatedLegalMoves(game, { relationships: true, mobility: true }).map(
      (move) => [move.id, move]
    )
  )
  const moves = fixture.order.map((id) => {
    const move = byId.get(id)
    assert.ok(move)
    return move
  })
  return { game, moves, currentThreats: currentThreats(game) }
}

for (const fixture of recorded) {
  test(`shared-v1-audited preserves recorded ${fixture.caseId} facts and adds recent-move context`, () => {
    const input = fixtureInput(fixture)
    const before = JSON.stringify(input)
    const result = buildSharedPrompt(input)
    assert.equal(
      createHash("sha256")
        .update(
          result.prompt.replace("Recent 8 moves (oldest first):\nnone\n", "")
        )
        .digest("hex"),
      fixture.sha256
    )
    assert.deepEqual(
      result.choices.map((choice) => choice.id),
      fixture.order
    )
    let previous = -1
    for (const choice of result.choices) {
      const index = result.prompt.indexOf(choice.outcome)
      assert.ok(index > previous)
      assert.equal(result.prompt.split(choice.outcome).length, 2)
      previous = index
    }
    assert.equal(JSON.stringify(input), before)
    assert.doesNotMatch(
      result.prompt,
      /\b(?:thinking|reasoning|thoughts|scratchpad)\b/i
    )
  })
}

test("shared prompt has no model or reasoning options and ignores opponent model/toggle metadata", () => {
  type ForbiddenKeys = Extract<
    keyof SharedPromptInput,
    "model" | "thinking" | "reasoning" | "budgetTokens" | "promptStyle"
  >
  const forbidden: Record<ForbiddenKeys, never> = {}
  assert.deepEqual(forbidden, {})
  assert.equal(SHARED_PROMPT_VERSION, "shared-v1-audited")
  const input = fixtureInput(recorded[0])
  const before = buildSharedPrompt(input)
  for (const model of ["prompt-api", "LiquidAI/LFM3-1.7B-GGUF"] as const) {
    for (const thinking of [false, true]) {
      const after = buildSharedPrompt({
        ...input,
        game: { ...input.game, opponent: { model, thinking } }
      })
      assert.deepEqual(after, before)
    }
  }
})

test("shared prompt includes exactly the last eight individual moves, oldest first, before the legal cards", () => {
  const game = [
    "e2e4",
    "e7e5",
    "g1f3",
    "b8c6",
    "f1c4",
    "g8f6",
    "d2d3",
    "f8c5",
    "b1c3"
  ].reduce(applyMove, newGame())
  const result = buildSharedPrompt({
    game,
    moves: annotatedLegalMoves(game, { relationships: true, mobility: true }),
    currentThreats: currentThreats(game)
  })
  const heading = "Recent 8 moves (oldest first):"
  const cardsHeading = "ALL LEGAL CARDS (random order, no ranking):"
  const section = result.prompt.split(heading)[1]?.split(cardsHeading)[0].trim()
  assert.ok(section)
  assert.deepEqual(
    section.split("\n"),
    game.history
      .slice(-8)
      .map(
        (move) =>
          `${move.side === "human" ? "White" : "Black"}: ${move.notation} (${move.id})`
      )
  )
  assert.equal(section.split("\n").length, 8)
  assert.doesNotMatch(section, /e2e4/)
  assert.ok(
    result.prompt.indexOf(heading) < result.prompt.indexOf(cardsHeading)
  )
})
