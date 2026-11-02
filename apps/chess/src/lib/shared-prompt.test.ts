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
import {
  buildSharedPrompt,
  SHARED_PROMPT_VERSION,
  positiveSafetySummaries
} from "./shared-prompt.ts"
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
  test(`shared-v5 preserves recorded ${fixture.caseId} facts and adds recent-move context`, () => {
    const input = fixtureInput(fixture)
    const before = JSON.stringify(input)
    const result = buildSharedPrompt(input)
    assert.equal(
      createHash("sha256")
        .update(
          result.prompt
            .replaceAll(
              "DANGER TO BLACK: White can win on its next move",
              "WHITE CAN CHECKMATE NEXT TURN"
            )
            .replace(
              "Consider conditional exchange losses before taking material.",
              "Consider IF RECAPTURED losses before taking material."
            )
            .replace(
              "When a legal castle has no listed conditional material-loss branch, prefer it",
              "When a legal castle is listed, prefer it"
            )
            .replace("Recent 8 moves (oldest first):\nnone\n", "")
            .replace(
              /URGENT POSITION FACTS:\n[\s\S]*?(?=Return exactly one JSON object:)/,
              ""
            )
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
  assert.equal(SHARED_PROMPT_VERSION, "shared-v5")
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

function safetyInput(fen: string): SharedPromptInput {
  const game = fromFen(fen)
  return {
    game,
    moves: annotatedLegalMoves(game, {
      relationships: true,
      mobility: true,
      safety: true
    }).reverse(),
    currentThreats: currentThreats(game)
  }
}

test("positive king-safety summary retains every qualifying ID in supplied order and excludes mating replies and material-loss branches", () => {
  const input = safetyInput(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const expected = input.moves
    .filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMajorLosses?.length === 0
    )
    .map((move) => move.id)
  assert.ok(expected.includes("d8f6"))
  assert.ok(!expected.includes("d8h4"))
  assert.ok(!expected.includes("c6d4"))
  assert.ok(!expected.includes("c6a5"))
  const summaries = positiveSafetySummaries(input)
  assert.ok(
    summaries.includes(
      `KING-SAFE CHOICES FOR THE NEXT TURN: ${expected.join(", ")}. Each prevents an immediate White checkmate without an uncompensated queen or rook loss.`
    )
  )
  const result = buildSharedPrompt(input)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
  for (const id of ["d8h4", "c6d4", "c6a5"])
    assert.ok(result.choices.some((choice) => choice.id === id))
  const header = result.prompt.indexOf("URGENT POSITION FACTS:")
  assert.ok(
    header >
      result.prompt.indexOf(result.choices[result.choices.length - 1].outcome)
  )
  assert.ok(header < result.prompt.indexOf("Return exactly one JSON object:"))
})

test("an immediately recapturable queen remains a positive choice when the queen trade has a legal compensating pawn recapture", () => {
  const input = safetyInput("3q3k/6p1/8/8/8/5Q2/8/7K b - - 0 40")
  const trade = input.moves.find((move) => move.id === "d8f6")
  assert.ok(trade)
  assert.ok(trade.outcome.recapture.count > 0)
  assert.deepEqual(trade.outcome.replyMajorLosses, [])
  const other = input.moves.find((move) => move.id !== trade.id)
  assert.ok(other)
  const withUrgency = {
    ...input,
    moves: input.moves.map((move) =>
      move.id === other.id
        ? { ...move, outcome: { ...move.outcome, allowsMateInOne: true } }
        : move
    )
  }
  const summary = positiveSafetySummaries(withUrgency).find((line) =>
    line.startsWith("KING-SAFE CHOICES")
  )
  assert.ok(summary)
  assert.ok(summary.includes("d8f6"))
})

test("missing safety metadata cannot be promoted to a factual king-safety claim", () => {
  const input = safetyInput(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const missing = {
    ...input,
    moves: input.moves.map((move) => ({
      ...move,
      outcome: {
        ...move.outcome,
        replyMajorLosses: undefined,
        replyMaterialLosses: undefined
      }
    }))
  }
  assert.deepEqual(positiveSafetySummaries(missing), [])
})

test("queen-rescue summary requires a current queen threat and an actual resolved threat without allowing immediate mate", () => {
  const input = safetyInput("r3k2r/5pp1/7p/3q4/4P3/8/5PPK/8 b kq - 0 1")
  assert.ok(input.currentThreats.some((threat) => threat.target.piece === "q"))
  const expected = input.moves
    .filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.relationships?.resolvedThreats.some(
          (piece) => piece.piece === "q"
        )
    )
    .map((move) => move.id)
  assert.ok(expected.length > 1)
  const summaries = positiveSafetySummaries(input)
  assert.ok(
    summaries.includes(
      `Black can RESCUE AN ATTACKED QUEEN from immediate legal capture with: ${expected.join(", ")}.`
    )
  )
  assert.ok(
    positiveSafetySummaries({ ...input, currentThreats: [] }).every(
      (line) => !line.includes("RESCUE AN ATTACKED QUEEN")
    )
  )
  const unsafe = {
    ...input,
    moves: input.moves.map((move) => ({
      ...move,
      outcome: { ...move.outcome, allowsMateInOne: true }
    }))
  }
  assert.deepEqual(positiveSafetySummaries(unsafe), [])
  const result = buildSharedPrompt(input)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
})

test("dangerous cards use a Black-danger label without the winning CHECKMATE marker, preserving every legal ID", () => {
  const input = safetyInput(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const result = buildSharedPrompt(input)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
  let dangerous = 0
  for (const move of input.moves) {
    const card = result.choices.find((choice) => choice.id === move.id)
    assert.ok(card)
    if (move.outcome.allowsMateInOne) {
      dangerous++
      assert.match(
        card.outcome,
        /DANGER TO BLACK: White can win on its next move/
      )
      assert.doesNotMatch(card.outcome, /CHECKMATE/)
    } else {
      assert.doesNotMatch(
        card.outcome,
        /DANGER TO BLACK: White can win on its next move/
      )
    }
  }
  assert.ok(dangerous > 0)
})

test("a genuine winning mate card retains its original positive CHECKMATE marker", () => {
  const game = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())
  const result = buildSharedPrompt({
    game,
    moves: annotatedLegalMoves(game, {
      relationships: true,
      mobility: true,
      safety: true
    }),
    currentThreats: currentThreats(game)
  })
  const mate = result.choices.find((choice) => choice.id === "d8h4")
  assert.ok(mate)
  assert.equal(mate.outcome, "d8h4 | queen d8-h4 | CHECKMATE: wins now")
  assert.doesNotMatch(mate.outcome, /DANGER TO BLACK/)
})

test("urgent response guidance follows positive lists and prioritizes defense or queen rescue before ordinary moves", () => {
  const defense = safetyInput(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const defenseFacts = positiveSafetySummaries(defense)
  assert.ok(
    defenseFacts.findIndex((line) => line.startsWith("KING-SAFE CHOICES")) <
      defenseFacts.indexOf("URGENT RESPONSE PRIORITY:")
  )
  assert.ok(
    defenseFacts.some((line) =>
      line.includes(
        "Before ordinary development or castling, choose one of the KING-SAFE choices"
      )
    )
  )
  const queen = safetyInput("r3k2r/5pp1/7p/3q4/4P3/8/5PPK/8 b kq - 0 1")
  const queenFacts = positiveSafetySummaries(queen)
  assert.ok(
    queenFacts.some((line) =>
      line.includes(
        "queen-rescue choices above that prevents an immediate White win"
      )
    )
  )
  const first = defense.moves[0]
  assert.ok(first)
  const winning = {
    ...defense,
    moves: defense.moves.map((move) =>
      move.id === first.id
        ? { ...move, outcome: { ...move.outcome, checkmate: true } }
        : move
    )
  }
  assert.ok(
    positiveSafetySummaries(winning).every(
      (line) => line !== "URGENT RESPONSE PRIORITY:"
    )
  )
})

test("a safe moving knight can still expose another rook, which remains a conditional loss fact", () => {
  const input = safetyInput("6k1/8/4r3/3n4/8/1B6/2P5/2K5 b - - 0 40")
  const move = input.moves.find((entry) => entry.id === "d5b6")
  assert.ok(move)
  assert.equal(move.outcome.recapture.count, 0)
  assert.equal(move.outcome.relationships?.newThreats.length, 0)
  const result = buildSharedPrompt(input)
  const card = result.choices.find((choice) => choice.id === move.id)
  assert.ok(card)
  assert.match(
    card.outcome,
    /after this move White bishop \(3\) on b3 can take Black rook \(5\) on e6; possible immediate exchange net -5/
  )
  assert.doesNotMatch(
    card.outcome,
    /always bad|cannot move|IF RECAPTURED NEXT TURN/
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((entry) => entry.id)
  )
})

test("an attack on an opposing rook cannot erase the newly exposed own queen when White moves next", () => {
  const input = safetyInput("3q2k1/8/3n4/8/8/8/8/3R3K b - - 0 40")
  const move = input.moves.find((entry) => entry.id === "d6f5")
  assert.ok(move)
  assert.equal(move.outcome.recapture.count, 0)
  assert.ok(move.outcome.relationships?.newThreats.length)
  const card = buildSharedPrompt(input).choices.find(
    (choice) => choice.id === move.id
  )
  assert.ok(card)
  assert.match(
    card.outcome,
    /White rook \(5\) on d1 can take Black queen \(9\) on d8; possible immediate exchange net -9/
  )
  assert.match(
    card.outcome,
    /Black also threatens White rook \(5\) on d1 on the unchanged board; White moves next/
  )
})

test("full exchange facts replace the moved-piece-only warning and never survive a terminal candidate", () => {
  const trade = safetyInput("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1")
  const card = buildSharedPrompt(trade).choices.find(
    (choice) => choice.id === "d8d4"
  )
  assert.ok(card)
  assert.doesNotMatch(card.outcome, /IF RECAPTURED NEXT TURN/)
  assert.match(
    card.outcome,
    /can take Black queen \(9\) on d4; possible immediate exchange net -4/
  )
  assert.equal(card.outcome.split("DANGER TO BLACK: after this move").length, 2)
  const exposure = safetyInput("6k1/8/4r3/3n4/8/1B6/2P5/2K5 b - - 0 40")
  const terminal = {
    ...exposure,
    moves: exposure.moves.map((move) =>
      move.id === "d5b6"
        ? { ...move, outcome: { ...move.outcome, checkmate: true } }
        : move
    )
  }
  const mate = buildSharedPrompt(terminal).choices.find(
    (choice) => choice.id === "d5b6"
  )
  assert.ok(mate)
  assert.match(mate.outcome, /CHECKMATE: wins now/)
  assert.doesNotMatch(
    mate.outcome,
    /after this move White|possible immediate exchange|Black also threatens/
  )
})

test("a knight fork cannot hide the legal king capture that loses that knight", () => {
  const input = safetyInput(
    "r3b2B/ppk2p1B/8/1P1P2p1/2P2n2/8/5PPP/2R1K2R b K - 0 29"
  )
  const move = input.moves.find((entry) => entry.id === "f4e2")
  assert.ok(move)
  assert.equal(move.outcome.replyMajorLosses?.length, 0)
  assert.equal(move.outcome.replyMaterialLosses?.[0]?.netMaterial, -3)
  const result = buildSharedPrompt(input)
  const card = result.choices.find((choice) => choice.id === move.id)
  assert.ok(card)
  assert.match(
    card.outcome,
    /White king \(royal\) on e1 can take Black knight \(3\) on e2; possible immediate exchange net -3/
  )
  assert.match(
    card.outcome,
    /Black also threatens White rook \(5\) on c1 on the unchanged board; White moves next/
  )
  assert.doesNotMatch(card.outcome, /IF RECAPTURED NEXT TURN|always bad/)
  const materialLine = positiveSafetySummaries(input).find((line) =>
    line.startsWith("MATERIAL-SAFE CHOICES")
  )
  assert.ok(materialLine)
  assert.ok(!materialLine.split(". No checked")[0].includes("f4e2"))
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((entry) => entry.id)
  )
})

test("knight takes pawn warns of the actual net loss with and without a friendly recapture", () => {
  for (const [fen, net] of [
    ["6k1/8/5n2/8/4P3/3P4/8/7K b - - 0 40", -2],
    ["6k1/8/5n2/5p2/4P3/3P4/8/7K b - - 0 40", -1]
  ] as const) {
    const input = safetyInput(fen)
    const card = buildSharedPrompt(input).choices.find(
      (choice) => choice.id === "f6e4"
    )
    assert.ok(card)
    assert.match(card.outcome, /CAPTURES pawn \(1\)/)
    assert.ok(card.outcome.includes(`possible immediate exchange net ${net}`))
    assert.doesNotMatch(card.outcome, /IF RECAPTURED NEXT TURN/)
  }
})

test("compensated queen and rook exchanges are not mislabeled by old two-ply warnings", () => {
  const trade = safetyInput("3q3k/6p1/8/8/8/5Q2/8/7K b - - 0 40")
  const queen = buildSharedPrompt(trade).choices.find(
    (choice) => choice.id === "d8f6"
  )
  assert.ok(queen)
  assert.match(queen.outcome, /COMPENSATING RECAPTURE AVAILABLE/)
  assert.doesNotMatch(
    queen.outcome,
    /IF RECAPTURED|exchange net -9|DANGER TO BLACK: after this move/
  )
  const compensation = safetyInput("6k1/8/5n2/5p2/4P3/3Q4/8/7K b - - 0 40")
  const knight = buildSharedPrompt(compensation).choices.find(
    (choice) => choice.id === "f6e4"
  )
  assert.ok(knight)
  assert.doesNotMatch(
    knight.outcome,
    /DANGER TO BLACK: after this move|IF RECAPTURED NEXT TURN/
  )
  const rookTrade = safetyInput("r6k/8/8/8/Q7/1P6/8/7K b - - 0 1")
  const rook = buildSharedPrompt(rookTrade).choices.find(
    (choice) => choice.id === "a8a4"
  )
  assert.ok(rook)
  assert.doesNotMatch(
    rook.outcome,
    /DANGER TO BLACK: after this move|IF RECAPTURED NEXT TURN/
  )
})

test("full exchange warnings need an actual negative capture branch and choose only the worst one", () => {
  const input = safetyInput("6k1/8/4r3/3n4/8/1B6/2P5/2K5 b - - 0 40")
  const move = input.moves.find((entry) => entry.id === "d5b6")
  assert.ok(move)
  const noAttack = {
    ...input,
    moves: input.moves.map((entry) =>
      entry.id === move.id
        ? { ...entry, outcome: { ...entry.outcome, replyMaterialLosses: [] } }
        : entry
    )
  }
  assert.doesNotMatch(
    buildSharedPrompt(noAttack).choices.find((choice) => choice.id === move.id)
      ?.outcome ?? "",
    /DANGER TO BLACK: after this move/
  )
  const losses = move.outcome.replyMaterialLosses
  assert.ok(losses?.[0])
  const multiple = {
    ...input,
    moves: input.moves.map((entry) =>
      entry.id === move.id
        ? {
            ...entry,
            outcome: {
              ...entry.outcome,
              replyMaterialLosses: [
                { ...losses[0], netMaterial: -1 },
                { ...losses[0], netMaterial: -5 },
                { ...losses[0], netMaterial: -3 }
              ]
            }
          }
        : entry
    )
  }
  const result = buildSharedPrompt(multiple)
  const card = result.choices.find((choice) => choice.id === move.id)
  assert.ok(card)
  assert.match(card.outcome, /exchange net -5/)
  assert.equal(card.outcome.split("DANGER TO BLACK: after this move").length, 2)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((entry) => entry.id)
  )
})

test("material-safe positive IDs require explicit full-exchange facts, preserve order, and never replace immediate wins", () => {
  const input = safetyInput("6k1/8/5n2/5p2/4P3/3P4/8/7K b - - 0 40")
  const expected = input.moves
    .filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMaterialLosses?.length === 0
    )
    .map((move) => move.id)
  const summaries = positiveSafetySummaries(input)
  assert.ok(
    summaries.includes(
      `MATERIAL-SAFE CHOICES FOR THE NEXT TURN: ${expected.join(", ")}. No checked immediate capture exchange loses Black material; White has no mate in one.`
    )
  )
  assert.ok(
    summaries.some((line) =>
      line.includes("After addressing the king and any attacked queen")
    )
  )
  const missing = {
    ...input,
    moves: input.moves.map((move) => ({
      ...move,
      outcome: { ...move.outcome, replyMaterialLosses: undefined }
    }))
  }
  assert.ok(
    positiveSafetySummaries(missing).every(
      (line) => !line.startsWith("MATERIAL-SAFE CHOICES")
    )
  )
  const first = input.moves[0]
  assert.ok(first)
  const winning = {
    ...input,
    moves: input.moves.map((move) =>
      move.id === first.id
        ? { ...move, outcome: { ...move.outcome, checkmate: true } }
        : move
    )
  }
  assert.ok(
    positiveSafetySummaries(winning).every(
      (line) => !line.startsWith("MATERIAL-SAFE CHOICES")
    )
  )
})
