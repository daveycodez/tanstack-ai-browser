import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import {
  annotatedLegalMoves,
  applyMove,
  currentThreats,
  fromFen,
  legalMoves,
  newGame,
  squareName
} from "./chess.ts"
import {
  buildSharedPrompt as buildPlayerPrompt,
  SHARED_PROMPT_VERSION,
  systemPromptFor,
  SHARED_SYSTEM_PROMPT,
  positiveSafetySummaries as rawSafetySummaries
} from "./shared-prompt.ts"
import type { SharedPromptInput } from "./shared-prompt.ts"
import { describeMoveChoice as moveChoiceLabel, moveChoiceLabel as modelMoveChoiceLabel } from "./move-choice.ts"

// Preserve the independent historical fact assertions across label formatting.
// Only known action-list segments are translated; board squares and history stay literal.
function legacySummaryLabels(input: SharedPromptInput, text: string): string {
  const descriptions = new Map(input.moves.map(move => [modelMoveChoiceLabel(move), moveChoiceLabel(move)] as const))
  return text.split("\n").map(line => {
    if (!/^(?:KING-SAFE CHOICES|MATERIAL-SAFE CHOICES|(?:Black|White|You) can (?:WIN|RESCUE)|Legal castles now:|Prefer these castles|Prefer safe captures)/.test(line)) return line
    const start = line.indexOf(": ") + 2
    if (start < 2) return line
    const sentenceEnd = line.indexOf(". ", start)
    const end = sentenceEnd >= 0 ? sentenceEnd : line.endsWith(".") ? line.length - 1 : line.length
    const delimiter = line.startsWith("Prefer safe captures") ? "; " : ", "
    const labels = line.slice(start, end).split(delimiter).map(label => descriptions.get(label) ?? label).join(delimiter)
    return line.slice(0, start) + labels + line.slice(end)
  }).join("\n")
}
function positiveSafetySummaries(input: SharedPromptInput): string[] {
  return rawSafetySummaries(input).map(line => legacySummaryLabels(input, line))
}

// Existing factual assertions use the original color vocabulary and decoded board.
// Reverse actor wording and omit the duplicate FEN line for those snapshots;
// numeric facts, squares, actions and order are untouched. Raw ownership and the
// exact FEN are tested separately below.
function buildSharedPrompt(input: SharedPromptInput) {
  const result = buildPlayerPrompt(input)
  const own = input.game.humanColor === "black" ? "White" : "Black"
  const enemy = own === "Black" ? "White" : "Black"
  const legacyNames = (value: string) => {
    let text = value.replace(/^Position FEN: .*\n/gm, "")
      .replace(/Your pieces \((?:dark|light)\):/g, `${own} pieces:`)
      .replace(/Opponent's pieces \((?:dark|light)\):/g, `${enemy} pieces:`)
      .replaceAll("Your king in check:", `${own} in check:`)
      .replaceAll("None of your non-king pieces are threatened.", `No threatened ${own} non-king pieces.`)
      .replaceAll("your opponent's", `${enemy}'s`)
      .replaceAll("no capture for you", `no ${own} capture`)
      .replaceAll("opponent moves next", `${enemy} moves next`)
      .replaceAll("You can ", `${own} can `)
      .replaceAll("You also threaten ", `${own} also threatens `)
      .replaceAll("you lose ", `${own} loses `)
      .replaceAll("you are ", `${own} is `)
    for (const noun of ["king", "queen", "rook", "bishop", "knight", "pawn", "piece", "move", "capture", "non-king"])
      text = text.replaceAll(`your ${noun}`, `${own} ${noun}`).replaceAll(`opponent's ${noun}`, `${enemy} ${noun}`)
    return text.replaceAll("opponent's moves next", `${enemy} moves next`)
      .replace(/\bopponent\b/g, enemy).replace(/\byou\b/g, own)
      .replace(/\bOPPONENT\b/g, enemy.toUpperCase()).replace(/\bYOU\b/g, own.toUpperCase())
      .replace(/^You:/gm, `${own}:`).replace(/^Opponent:/gm, `${enemy}:`)
      .replace(`restrict the ${enemy}'s king`, "restrict the enemy king").replace(`restrict the ${enemy} king`, "restrict the enemy king")
  }
  const choices = result.choices.map(choice => {
    const move = input.moves.find(move => move.id === choice.id)
    assert.ok(move)
    const label = moveChoiceLabel(move)
    return { ...choice, label, outcome: choice.outcome.replace(`${choice.label} | ${label} | AFTER:`, `${label} | AFTER:`) }
  })
  let prompt = result.prompt
  for (let i = 0; i < choices.length; i++) prompt = prompt.replace(result.choices[i].outcome, choices[i].outcome)
  return { ...result, prompt: legacyNames(legacySummaryLabels(input, prompt)), choices: choices.map(choice => ({ ...choice, outcome: legacyNames(choice.outcome) })) }
}

// Exact pre-footer facts and cards recorded before opportunity summaries generalized.
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
    sha256: "299236002071e93529a02c660ed5c7f7161e5151fb92996202f108c0ce390877"
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
    sha256: "b8fce8e95b2e739e9af23e45fdc89316c00ac758a3898fc2ad91b5672cc44a9e"
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
    sha256: "673a0532987a6cc9e31cb59ab239300f2bc72469b5d6c840b06e01255193ee06"
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
    sha256: "19f8739cd5e4470806b1ed2793e6a512170336091947ee6032edf9c78eba3111"
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
    sha256: "fbf324446729579251006f6e4531792ace788bb0f4f8a5b8180dc16a8f558168"
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

function choiceLabelOf(input: SharedPromptInput, id: string) {
  const move = input.moves.find((entry) => entry.id === id)
  assert.ok(move)
  return moveChoiceLabel(move)
}

function restoreAuditCardHeaders(moves: SharedPromptInput["moves"], prompt: string) {
  prompt = prompt.replaceAll("CAPTURER SAFE from immediate recapture", "MOVED PIECE CANNOT BE LEGALLY RECAPTURED NEXT TURN")
  prompt = prompt.replaceAll("LOSS NEXT TURN: White mates Black", "DANGER TO BLACK: White can win on its next move")
  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }
  for (const move of moves) {
    const short = `${moveChoiceLabel(move)} | SAN ${move.notation} | `
    prompt = prompt.replace(`${moveChoiceLabel(move)} | AFTER: `, short)
    const full = `${short}UCI ${move.id} | ${names[move.piece]} ${squareName(move.path[0])}-${squareName(move.path[1])} | `
    if (!prompt.includes(full)) prompt = prompt.replace(short, full)
  }
  return prompt
}

function legacyCardPrefix(input: SharedPromptInput, prompt: string) {
  let result = restoreAuditCardHeaders(input.moves, prompt)
  for (const move of input.moves)
    result = result.replace(
      `${moveChoiceLabel(move)} | SAN ${move.notation} | UCI ${move.id} | `,
      `${move.id} | `
    )
  const castles = input.moves.flatMap((move) =>
    move.notation.startsWith("O-O")
      ? [
          `${move.notation.startsWith("O-O-O") ? "queenside" : "kingside"} ${move.id}`
        ]
      : []
  )
  result = result.replace(/; CONTEXT: [^\n]*/g, "")
  result = result.replace(
    "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; take safe material gains, including forcing checks that win material.",
    "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; take safe material gains, including forcing checks that win material; otherwise consider castling or purposeful development with a knight, bishop, or central pawn."
  )
  for (const line of [
    "In the opening, central pawn pushes gain space and can free bishops or knights for development.",
    "Balance king-flank pawn cover with space, piece activity and castling; near-cover counts describe pawn files on the two pawn ranks nearest home, not a material score or a ban on useful pawn moves.",
    "Address uncompensated promotion threats; legal recaptures or material gains can justify allowing promotion.",
    "With few opposing pieces, coordinate king and major pieces to restrict the enemy king while preserving material and avoiding stalemate; destination counts alone do not prove mate."
  ])
    result = result.replace(line + "\n", "")
  result = result.replace(
    "otherwise consider castling or purposeful development with a knight, bishop, or central pawn.",
    "otherwise CASTLE when listed; otherwise develop a knight/bishop or advance a central pawn."
  )
  return result.replace(
    /^Legal castling moves now:.*$/m,
    `Legal CASTLE IDs now: ${castles.join(", ") || "none"}.`
  )
}

// Historical factual projection only: guidance moved from USER to SYSTEM in V19.
// Restore the old positions so existing independent facts hashes remain unchanged.
function restoreLegacyUserLayout(prompt: string, quiet = false, input?: SharedPromptInput): string {
  prompt = prompt.replaceAll(" Avoid negative exchange nets.", "")
  prompt = prompt.replace(" Choose a win; avoid STALEMATE (draw).", "")
  prompt = prompt.replace("Prefer safe captures (KING-SAFE and MATERIAL-SAFE):", "Available captures with no immediate legal recapture of the moved piece:")
  prompt = prompt.replace("BOARD NOW:", "Current position:")
  prompt = prompt.replaceAll("LOSS NEXT TURN: White mates Black", "DANGER TO BLACK: White can win on its next move")
  prompt = prompt.replace("Choose a KING-SAFE move; within that set prefer a safe capture or forcing gain to a quiet move.", "Before ordinary development or castling, choose one of the KING-SAFE choices above to address the immediate threat.")
  prompt = prompt.replace("Within the king/queen-safe choices, prefer MATERIAL-SAFE captures or forcing gains to quiet moves or non-winning checks.", "After addressing the king and any attacked queen, prefer a MATERIAL-SAFE material gain or a forcing material-winning check over a quiet move.").replace("After king/queen safety, choose a listed MATERIAL-SAFE move. Keep threatened pieces defended before castling or development.", "After addressing the king and any attacked queen, prefer a MATERIAL-SAFE choice. When there is no urgent threat, consider castling or purposeful development among these choices.")
  if (input) prompt = restoreAuditCardHeaders(input.moves, prompt)
  for (const [short, full] of [["Central pawn pushes gain space and can free bishops or knights.", "In the opening, central pawn pushes gain space and can free bishops or knights for development."], ["Near-files counts pawn files on the two pawn ranks nearest home. Balance cover with space, piece activity and castling; no material score or pawn-move ban.", "Balance king-flank pawn cover with space, piece activity and castling; near-cover counts describe pawn files on the two pawn ranks nearest home, not a material score or a ban on useful pawn moves."], ["Answer promotion threats unless legal recaptures or material gains compensate.", "Address uncompensated promotion threats; legal recaptures or material gains can justify allowing promotion."], ["Coordinate king and major pieces to restrict the enemy king; keep material, avoid stalemate. Destination counts alone do not prove mate.", "With few opposing pieces, coordinate king and major pieces to restrict the enemy king while preserving material and avoiding stalemate; destination counts alone do not prove mate."], ["NEXT MOVE OPTIONS:", "ALL LEGAL CARDS (presentation order, no ranking):"], ["White capture possibilities on the unchanged board:", "Current White capture possibilities on the unchanged board:"], ["Legal castles now:", "Legal castling moves now:"]]) prompt = prompt.replace(short, full)
  prompt = prompt.replace("Black pieces:", "Black pieces (you):").replace("White pieces:", "White pieces (opponent):")
  const values = { king: "royal", queen: 9, rook: 5, bishop: 3, knight: 3, pawn: 1 }
  prompt = prompt.split("\n").map((line) => line.startsWith("Black ") && line.includes("can be captured by White")
    ? line.replace(/\b(king|queen|rook|bishop|knight|pawn) ([a-h][1-8])/g, (_, piece: keyof typeof values, square: string) => `${piece} (${values[piece]}) on ${square}`) : line).join("\n")
  // Restore the historical answer footer only for the existing V15/V18 snapshot hashes.
  const capturePriority = prompt.includes("Available captures with no immediate legal recapture of the moved piece:") ? "\nAfter addressing the king, any attacked queen, and immediate mate, favor safe material gains. A forcing check that wins further material can be better than a larger immediate capture. A check alone does not justify a listed material loss." : ""
  const oldPriorities = quiet ? "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; take safe material gains, including forcing checks that win material; otherwise consider castling or purposeful development with a knight, bishop, or central pawn." : "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; take safe material gains, including forcing checks that win material."
  const legacy = prompt.replace("Current position:", "Black to move. Play a fun, sensible casual game. Choose one legal card.\n" + oldPriorities) + capturePriority + "\nReturn exactly one JSON object: key move, value the exact action label at the start of the chosen card. Copy the full label, including coordinates and any promotion or en passant text. Stop after the closing brace."
  return legacy
    .replace(/^(Priorities:.*)$/m, "$1\nA check alone is not a material gain. Account for forcing follow-up captures and the conditional exchange losses before taking material. Protection is not immunity. Pawn 1, knight/bishop 3, rook 5, queen 9.")
    .replace("ALL LEGAL CARDS (presentation order, no ranking):", "HOW TO READ THE CARDS:\nThe board above is the position now. Each card describes a separate possible position after only that Black move. Its DANGER and exchange facts apply only to that move; destinations and threats from different cards do not occur together. CHECK on a card means that move checks White. Black in check above describes now.\nALL LEGAL CARDS (random order, no ranking):")
}

for (const fixture of recorded) {
  test(`shared-v33 preserves recorded ${fixture.caseId} facts and adds recent-move context`, () => {
    const input = fixtureInput(fixture)
    const before = JSON.stringify(input)
    const result = buildSharedPrompt(input)
    assert.equal(
      createHash("sha256")
        .update(
          legacyCardPrefix(input, restoreLegacyUserLayout(result.prompt, fixture.caseId === "context-castle-now", input))
            .replace(
              "In the opening, central pawn pushes gain space and can free bishops or knights for development. Balance king-flank pawn cover with space, piece activity and castling; near-cover counts describe pawn files on the two pawn ranks nearest home, not a material score or a ban on useful pawn moves.\n",
              ""
            )
            .replace(
              "Address uncompensated promotion threats; legal recaptures or material gains can justify allowing promotion. With few opposing pieces, coordinate king and major pieces to restrict the enemy king while preserving material and avoiding stalemate; destination counts alone do not prove mate.\n",
              ""
            )
            .replaceAll(
              "DANGER TO BLACK: White can win on its next move",
              "WHITE CAN CHECKMATE NEXT TURN"
            )
            .replace(
              "take safe material gains, including forcing checks that win material; ",
              ""
            )
            .replace(
              "A check alone is not a material gain. Account for forcing follow-up captures and the conditional exchange losses before taking material.",
              "A check alone is not a reason to move. Consider conditional exchange losses before taking material."
            )
            .replace(
              "Consider conditional exchange losses before taking material.",
              "Consider IF RECAPTURED losses before taking material."
            )
            .replace(
              "When a legal castle has no listed conditional material-loss branch, prefer it",
              "When a legal castle is listed, prefer it"
            )
            .replace(
              "HOW TO READ THE CARDS:\nThe board above is the position now. Each card describes a separate possible position after only that Black move. Its DANGER and exchange facts apply only to that move; destinations and threats from different cards do not occur together. CHECK on a card means that move checks White. Black in check above describes now.\n",
              ""
            )
            .replace("Recent 8 moves (oldest first):\nnone\n", "")
            .split(
              /\n(?:CASTLING CHECK BEFORE YOUR ANSWER:|AVAILABLE IMMEDIATE OPPORTUNITIES:|URGENT POSITION FACTS:|Return exactly one JSON object:)/
            )[0]
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
  assert.equal(SHARED_PROMPT_VERSION, "shared-v98-prefer-safe-captures")
  const input = fixtureInput(recorded[0])
  const before = buildSharedPrompt(input)
  for (const model of ["prompt-api", "LiquidAI/LFM3-1.7B-GGUF", "unsloth/Qwen3.5-2B-GGUF"] as const) {
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
  ].reduce(applyMove, newGame("white"))
  const result = buildSharedPrompt({
    game,
    moves: annotatedLegalMoves(game, { relationships: true, mobility: true }),
    currentThreats: currentThreats(game)
  })
  const heading = "Recent 8 moves (oldest first):"
  const cardsHeading = "NEXT MOVE OPTIONS:"
  const section = result.prompt
    .split(heading)[1]
    ?.split(cardsHeading)[0]
    .trim()
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
      `KING-SAFE CHOICES FOR THE NEXT TURN: ${expected.map((id) => choiceLabelOf(input, id)).join(", ")}. Each prevents an immediate White checkmate without an uncompensated queen or rook loss.`
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
  assert.ok(summary.includes(moveChoiceLabel(trade)))
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
      `Black can RESCUE AN ATTACKED QUEEN from immediate legal capture with: ${expected.map((id) => choiceLabelOf(input, id)).join(", ")}.`
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

test("dangerous cards use an explicit losing label without the winning CHECKMATE marker, preserving every legal ID", () => {
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
        /LOSS NEXT TURN: White mates Black/
      )
      assert.doesNotMatch(card.outcome, /CHECKMATE/)
    } else {
      assert.doesNotMatch(
        card.outcome,
        /LOSS NEXT TURN: White mates Black/
      )
    }
  }
  assert.ok(dangerous > 0)
})

test("a genuine winning mate card retains its original positive CHECKMATE marker", () => {
  const game = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame("white"))
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
  assert.equal(
    mate.outcome,
    "Move queen d8 to h4 | AFTER: CHECKMATE: wins now"
  )
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
        "Choose a KING-SAFE move; within that set prefer a safe capture"
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
  assert.ok(!materialLine.split(". No checked")[0].includes("Ne2"))
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
      `MATERIAL-SAFE CHOICES FOR THE NEXT TURN: ${expected.map((id) => choiceLabelOf(input, id)).join(", ")}. No checked immediate capture exchange loses Black material; White has no mate in one.`
    )
  )
  assert.ok(
    summaries.some((line) =>
      line.includes("After king/queen safety")
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

test("recorded Nh3 loss cannot simultaneously claim a compensating recapture", () => {
  const input = safetyInput(
    "r3b2B/ppk2p1B/8/1P1P2p1/2P2n2/8/5PPP/2R1K2R b K - 0 29"
  )
  const result = buildSharedPrompt(input)
  const knight = result.choices.find((choice) => choice.id === "f4h3")
  assert.ok(knight)
  assert.match(
    knight.outcome,
    /^Move knight f4 to h3 \| AFTER: DANGER TO BLACK:/
  )
  assert.match(
    knight.outcome,
    /White pawn \(1\) on g2 can take Black knight \(3\) on h3; possible immediate exchange net -3/
  )
  assert.doesNotMatch(
    knight.outcome,
    /COMPENSATING RECAPTURE AVAILABLE|IF RECAPTURED NEXT TURN/
  )
  for (const choice of result.choices) {
    if (choice.outcome.includes("possible immediate exchange net -"))
      assert.doesNotMatch(choice.outcome, /COMPENSATING RECAPTURE AVAILABLE/)
  }
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
})

test("the shared factual legend distinguishes current board facts, independent candidate positions, and who is checked", () => {
  const input = safetyInput(
    "r3b2B/ppk2p1B/8/1P1P2p1/2P2n2/8/5PPP/2R1K2R b K - 0 29"
  )
  const result = buildSharedPrompt(input)
  const heading = "BOARD NOW is current."
  const cards = "NEXT MOVE OPTIONS:"
  const legend = SHARED_SYSTEM_PROMPT.split("\n\n").find((part) => part.startsWith("BOARD NOW"))
  assert.equal(
    legend,
    "BOARD NOW is current. NEXT MOVE OPTIONS are alternatives, not history; AFTER predicts only that move. CHECK attacks White's king; it is not checkmate. SAN labels: x captures, + check, # mate."
  )
  assert.equal(SHARED_SYSTEM_PROMPT.split(heading).length, 2)
  assert.ok(!result.prompt.includes(heading))
  assert.ok(result.prompt.includes(cards))
  assert.ok(
    result.prompt.indexOf("AVAILABLE IMMEDIATE OPPORTUNITIES:") >
      result.prompt.indexOf("URGENT POSITION FACTS:") ||
      !result.prompt.includes("AVAILABLE IMMEDIATE OPPORTUNITIES:")
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
  assert.doesNotMatch(
    legend ?? "",
    /\b(?:thinking|reasoning|thoughts|scratchpad)\b/i
  )
})

test("capture priority favors larger safe material gains after queen safety and before castling without changing cards", () => {
  const input = safetyInput("r3k2r/5pp1/7p/3q4/4P3/8/5PPK/8 b kq - 0 1")
  const result = buildSharedPrompt(input)
  const priority = SHARED_SYSTEM_PROMPT
    .split("\n")
    .find((line) => line.startsWith("Take a listed CHECKMATE"))
  assert.ok(priority)
  const queen = priority.indexOf("save or win a queen")
  const gain = priority.indexOf("safe material")
  const castle = priority.indexOf("castling/development")
  assert.ok(queen >= 0 && gain > queen)
  assert.ok(castle > gain)
  assert.equal(
    SHARED_SYSTEM_PROMPT.split("safe material").length,
    2
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
})

const captureSummary = (prompt: string) =>
  prompt
    .split("\n")
    .find((line) =>
      line.startsWith("Prefer safe captures (KING-SAFE and MATERIAL-SAFE):")
    )

test("capture opportunities include every eligible piece value in caller order without ranking or removing cards", () => {
  const input = safetyInput("r5k1/5ppp/8/2p1p3/3B1P2/8/5PPP/6K1 b - - 0 1")
  const pawn = input.moves.find((move) => move.id === "e5f4")
  const bishop = input.moves.find((move) => move.id === "e5d4")
  assert.ok(pawn && bishop)
  const ordered = {
    ...input,
    moves: [pawn, ...input.moves.filter((move) => move.id !== pawn.id)]
  }
  const result = buildSharedPrompt(ordered)
  const summary = captureSummary(result.prompt)
  assert.ok(summary)
  assert.ok(
    summary.indexOf("Capture pawn (1): pawn e5 to f4") <
      summary.indexOf("Capture bishop (3): pawn e5 to d4")
  )
  const eligible = ordered.moves.filter(
    (move) =>
      move.captured &&
      move.captured !== "k" &&
      move.outcome.recapture.count === 0 &&
      move.outcome.replyMaterialLosses?.length === 0 &&
      !move.outcome.allowsMateInOne &&
      !move.outcome.checkmate &&
      !move.outcome.stalemate &&
      !move.outcome.drawReason
  )
  let previous = -1
  for (const move of eligible) {
    const index = summary.indexOf(moveChoiceLabel(move))
    assert.ok(index > previous)
    previous = index
  }
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    ordered.moves.map((move) => move.id)
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /safe material/
  )
})

test("the observed free bishop is highlighted, while the later queen-rescue position excludes the losing bishop capture", () => {
  const before = safetyInput(
    "rBb1kbnN/4p1pp/1pp5/pq6/8/1PP2QP1/P3NP1P/R3K2R b KQq - 0 17"
  )
  assert.match(
    captureSummary(buildSharedPrompt(before).prompt) ?? "",
    /Capture bishop \(3\): rook a8 to b8/
  )
  const later = safetyInput(
    "rBb1kbnN/4p1pp/1pp5/1q6/P7/2P2QP1/P3NP1P/R3K2R b KQq - 0 18"
  )
  const summary = captureSummary(buildSharedPrompt(later).prompt)
  assert.ok(summary)
  assert.ok(!summary.includes("Capture bishop (3): rook a8 to b8"))
  assert.match(summary, /Capture pawn \(1\): queen b5 to a4/)
  assert.ok(
    positiveSafetySummaries(later).some((line) =>
      line.includes("RESCUE AN ATTACKED QUEEN")
    )
  )
})

test("free queen capture highlighting remains protected by the stronger general eligibility contract", () => {
  const input = safetyInput("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")
  assert.match(
    captureSummary(buildSharedPrompt(input).prompt) ?? "",
    /Capture queen \(9\): pawn e5 to d4/
  )
  const target = input.moves.find((move) => move.id === "e5d4")
  assert.ok(target)
  const variants = [
    { ...target, outcome: { ...target.outcome, recapture: { count: 1 } } },
    {
      ...target,
      outcome: { ...target.outcome, replyMaterialLosses: undefined }
    },
    {
      ...target,
      outcome: {
        ...target.outcome,
        replyMaterialLosses: [
          {
            piece: "p" as const,
            square: target.path[1],
            capturedBy: { piece: "p" as const, square: 0 },
            netMaterial: -1
          }
        ]
      }
    },
    { ...target, outcome: { ...target.outcome, allowsMateInOne: true } },
    { ...target, outcome: { ...target.outcome, stalemate: true } },
    { ...target, outcome: { ...target.outcome, drawReason: "Fifty-move rule" } }
  ]
  for (const changed of variants) {
    const result = buildSharedPrompt({
      ...input,
      moves: input.moves.map((move) => (move.id === target.id ? changed : move))
    })
    assert.ok(!captureSummary(result.prompt)?.includes(moveChoiceLabel(target)))
    assert.ok(result.choices.some((choice) => choice.id === target.id))
  }
})

test("immediate wins retain priority over the general capture opportunity reminder", () => {
  const input = safetyInput("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")
  const first = input.moves.find((move) => move.id !== "e5d4")
  assert.ok(first)
  const result = buildSharedPrompt({
    ...input,
    moves: input.moves.map((move) =>
      move.id === first.id
        ? { ...move, outcome: { ...move.outcome, checkmate: true } }
        : move
    )
  })
  assert.ok(
    result.prompt.includes(
      `Black can WIN THIS TURN with: ${moveChoiceLabel(first)}.`
    )
  )
  assert.equal(captureSummary(result.prompt), undefined)
  assert.doesNotMatch(result.prompt, /After addressing the king, any attacked queen, and immediate mate/)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
})

const v10CardHashes: Record<string, string> = {
  "mate-in-one":
    "f2885e342d5f0f6d36296ca81fa5fbe9bda64ba16b8ee11aa14d0cd4bf7d8791",
  "free-queen":
    "f75f9de2dca7dbf0b20e0e387c648cbd89ba5deb993bdfb70833abb390b2fe7d",
  "defended-trade":
    "b1abe94899d77ff7eeae6baddd14a498c607978d2ae3996be1d9721a21cb4f52",
  "castle-or-save-queen":
    "ded03222a303e81411f5f10f584af050d703cb352dd62021a044518415f30ee1",
  "context-castle-now":
    "94c08c952c55208f55a8aea3755e7c1b158ff23b639734bb6a18245847aa58a6"
}

test("the concise shared system role carries card interpretation and material guidance without model or reasoning directives", () => {
  assert.equal(SHARED_SYSTEM_PROMPT.split("Protection is not immunity.").length, 2)
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /Play chess as Black\. Use the decoded piece lists and computed outcomes/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /Forcing gains can outweigh immediate captures/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /check alone cannot justify material loss/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /order is unranked/
  )
  assert.doesNotMatch(
    SHARED_SYSTEM_PROMPT,
    /\b(?:thinking|reasoning|thoughts|scratchpad|Gemini|Nano|LFM3|WebGL)\b/i
  )
})

for (const fixture of recorded) {
  test(`English action presentation preserves V10 ${fixture.caseId} factual cards and legal order`, () => {
    const input = fixtureInput(fixture)
    const byId = new Map(
      annotatedLegalMoves(input.game, {
        relationships: true,
        mobility: true,
        safety: true
      }).map((move) => [move.id, move])
    )
    const moves = input.moves.map((move) => {
      const annotated = byId.get(move.id)
      assert.ok(annotated)
      return annotated
    })
    const result = buildSharedPrompt({ ...input, moves })
    assert.equal(
      createHash("sha256")
        .update(
          result.choices
            .map((choice) =>
              restoreAuditCardHeaders(input.moves, choice.outcome)
                .replace(
                  `${choice.label} | SAN ${choice.notation} | UCI ${choice.id} | `,
                  `${choice.id} | `
                )
                .replace(/; CONTEXT: .*$/, "")
            )
            .join("\n")
        )
        .digest("hex"),
      v10CardHashes[fixture.caseId]
    )
    assert.ok(!result.prompt.includes(SHARED_SYSTEM_PROMPT))
    assert.deepEqual(
      result.choices.map((choice) => choice.id),
      input.moves.map((move) => move.id)
    )
  })
}

test("model-facing short labels match the schema while English descriptions and UCI remain auditable", () => {
  const input = safetyInput("1B2kbnN/4p1pp/1pp5/2q2N2/8/2P3P1/R2K1P1P/7R b - - 0 25")
  const result = buildPlayerPrompt(input)
  for (const choice of result.choices) {
    const move = input.moves.find(move => move.id === choice.id)
    assert.ok(move)
    assert.equal(choice.label, modelMoveChoiceLabel(move))
    assert.equal(choice.notation, move.notation)
    assert.ok(choice.outcome.startsWith(`${choice.label} | ${moveChoiceLabel(move)} | AFTER:`))
  }
  const summary = captureSummary(result.prompt)
  assert.ok(summary)
  assert.match(summary, /Qxf5/)
  assert.match(summary, /Qxf2\+/)
  assert.doesNotMatch(summary, /Move queen|Capture knight|c5f5|c5f2/)
  assert.doesNotMatch(result.prompt, /Return exactly one JSON object|Copy the full label|Stop after the closing brace|key moveId/)
})

test("immediate capture opportunities follow safety summaries without a repeated capture footer", () => {
  const input = safetyInput(
    "1B2kbnN/4p1pp/1pp5/2q2N2/8/2P3P1/R2K1P1P/7R b - - 0 25"
  )
  const result = buildSharedPrompt(input)
  const safety = result.prompt.indexOf("URGENT POSITION FACTS:")
  const opportunities = result.prompt.indexOf(
    "AVAILABLE IMMEDIATE OPPORTUNITIES:"
  )
  assert.ok(safety >= 0 && opportunities > safety)
  assert.doesNotMatch(result.prompt, /After addressing the king, any attacked queen, and immediate mate/)
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /Forcing gains can outweigh immediate captures/
  )
  const summary = captureSummary(result.prompt)
  assert.ok(summary)
  assert.match(summary, /Capture pawn \(1\): queen c5 to f2/)
  assert.match(summary, /Capture knight \(3\): queen c5 to f5/)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.notation),
    input.moves.map((move) => move.notation)
  )
})

test("shared priorities allow forcing material-winning checks without treating a checking queen loss as compensation", () => {
  const input = safetyInput(
    "1B2kbnN/4p1pp/1pp5/2q2N2/8/2P3P1/R2K1P1P/7R b - - 0 25"
  )
  const result = buildSharedPrompt(input)
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /Play chess as Black\. Use the decoded piece lists and computed outcomes/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /forcing follow-ups/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /check alone cannot justify material loss/
  )
  assert.match(SHARED_SYSTEM_PROMPT, /forcing follow-ups/)
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /Forcing gains can outweigh immediate captures/
  )
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /check alone cannot justify material loss/
  )
  assert.doesNotMatch(
    result.prompt,
    /take the largest safe capture|pawn capture that gives check is still only a pawn/
  )
  const capture = captureSummary(result.prompt)
  assert.ok(capture)
  assert.match(capture, /Capture pawn \(1\): queen c5 to f2/)
  assert.match(capture, /Capture knight \(3\): queen c5 to f5/)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
})

function positionalInput(game: ReturnType<typeof newGame>): SharedPromptInput {
  return {
    game,
    moves: annotatedLegalMoves(game, {
      relationships: true,
      mobility: true,
      safety: true,
      support: true,
      castling: true,
      kingCover: true
    }),
    currentThreats: currentThreats(game)
  }
}
const contextOf = (input: SharedPromptInput, id: string) =>
  buildSharedPrompt(input)
    .choices.find((choice) => choice.id === id)
    ?.outcome.split("; CONTEXT: ")[1] ?? ""

test("pawn context opens minor pieces and preserves central two-square space without rewarding rook mobility", () => {
  const game = applyMove(newGame("white"), "e2e4")
  const input = positionalInput(game)
  for (const id of ["e7e5", "d7d5"]) {
    const context = contextOf(input, id)
    assert.match(context, /central pawn advances 2 squares/)
    assert.match(context, /frees blocked bishop [cf]8/)
    assert.doesNotMatch(context, /opens.*rook|develop.*queen/)
  }
  assert.match(contextOf(input, "g7g6"), /frees blocked bishop f8/)
  assert.doesNotMatch(
    contextOf(input, "a7a5"),
    /opens.*rook|rook.*opens|frees.*rook/
  )
  const result = buildSharedPrompt(input)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.label),
    input.moves.map(moveChoiceLabel)
  )
  for (const choice of result.choices) {
    assert.ok(choice.outcome.split("; CONTEXT: ").length <= 2)
    assert.ok((choice.outcome.split("; CONTEXT: ")[1]?.length ?? 0) <= 180)
  }
})

test("g6 and h6 retain three near cover files while g5 with h6 records two without assigning material loss", () => {
  const start = fromFen("6k1/5ppp/8/8/8/8/8/4K3 b - - 0 40")
  for (const id of ["g7g6", "h7h6"]) {
    const context = contextOf(positionalInput(start), id)
    assert.match(context, /current king g8 kingside near-files 3->3/)
    assert.doesNotMatch(context, /bad|loss|unsafe|future castle/)
  }
  const h6 = ["h7h6", "e1e2"].reduce(applyMove, start)
  assert.match(
    contextOf(positionalInput(h6), "g7g5"),
    /current king g8 kingside near-files 3->2 \[f7,g5,h6\]/
  )
  const g5 = ["g7g5", "e1e2"].reduce(applyMove, start)
  assert.match(
    contextOf(positionalInput(g5), "h7h6"),
    /near-files 2->2 \[f7,g5,h6\]/
  )
})

test("future castle cover requires retained rights, current landing cover survives castling and temporary blockage is distinct", () => {
  const start = fromFen("r3k2r/ppp2ppp/8/8/8/8/8/4K3 b kq - 0 40")
  const input = positionalInput(start)
  assert.match(
    contextOf(input, "g7g6"),
    /future castle kingside near-files 3->3/
  )
  for (const id of ["e8g8", "e8c8"]) {
    const context = contextOf(input, id)
    assert.match(context, /current king [gc]8 .*near-files 3/)
    assert.doesNotMatch(context, /future castle|loses.*rights/)
  }
  assert.match(contextOf(input, "h8g8"), /kingside castling rights: held->gone/)
  const returned = ["h8g8", "e1d1", "g8h8", "d1e1"].reduce(applyMove, start)
  assert.doesNotMatch(
    contextOf(positionalInput(returned), "g7g5"),
    /future castle kingside|castling rights: held->gone|prepar/
  )
  const castled = ["e8g8", "e1d1"].reduce(applyMove, start)
  assert.match(
    contextOf(positionalInput(castled), "g7g5"),
    /current king g8 kingside near-files 3->2/
  )
  const blocked = positionalInput(
    fromFen("r3kbnr/ppp2ppp/8/8/8/8/8/4K3 b kq - 0 40")
  )
  assert.match(
    contextOf(blocked, "f8e7"),
    /kingside clears f8, still blocked g8/
  )
  const attacked = positionalInput(
    fromFen("r3kb1r/ppp3pp/8/8/8/8/8/4KR2 b kq - 0 40")
  )
  assert.match(
    contextOf(attacked, "f8e7"),
    /path clear, castling temporarily prevented/
  )
})

test("opposite-wing pawn advances do not report degradation around a queenside king", () => {
  const input = positionalInput(
    fromFen("2kr3r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R b KQ - 0 40")
  )
  assert.doesNotMatch(
    contextOf(input, "g7g5"),
    /current king|future castle|near-files/
  )
})

test("new protection of an unattacked queen or rook is support, never a rescue or a stream of pawn support tags", () => {
  for (const piece of ["q", "r"] as const) {
    const input = positionalInput(
      fromFen(`3b3k/8/3${piece}4/8/8/8/8/7K b - - 0 40`)
    )
    const context = contextOf(input, "d8e7")
    assert.ok(
      context.includes(
        `adds protection to ${piece === "q" ? "queen" : "rook"} d6 (0->1)`
      )
    )
    assert.doesNotMatch(context, /rescue|safe|immune/)
    const move = input.moves.find((entry) => entry.id === "d8e7")
    assert.ok(move?.outcome.support)
    const originalSupport = move.outcome.support
    const lowValue = {
      ...input,
      moves: input.moves.map((entry) =>
        entry.id === move.id
          ? {
              ...entry,
              outcome: {
                ...entry.outcome,
                support: {
                  ...originalSupport,
                  addedFriendlySupport:
                    originalSupport.addedFriendlySupport.map((support) => ({
                      ...support,
                      target: { ...support.target, piece: "p" as const }
                    }))
                }
              }
            }
          : entry
      )
    }
    assert.doesNotMatch(contextOf(lowValue, move.id), /adds protection/)
  }
})

test("positional context never changes exact schema labels and is suppressed for terminal candidates", () => {
  const game = applyMove(newGame("white"), "e2e4")
  const full = positionalInput(game)
  const baseline = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    safety: true
  })
  assert.deepEqual(
    full.moves.map(moveChoiceLabel),
    baseline.map(moveChoiceLabel)
  )
  assert.deepEqual(
    buildSharedPrompt(full).choices.map((choice) => choice.label),
    baseline.map(moveChoiceLabel)
  )
  const mate = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame("white"))
  const win = buildSharedPrompt(positionalInput(mate)).choices.find(
    (choice) => choice.id === "d8h4"
  )
  assert.ok(win)
  assert.match(win.outcome, /CHECKMATE: wins now/)
  assert.doesNotMatch(
    win.outcome,
    /CONTEXT|future castle|near-files|protection/
  )
})

test("adding a defender to an attacked queen is labeled support while the legal capture remains", () => {
  const game = fromFen("3b3k/8/3q4/8/8/8/8/3R3K b - - 0 40")
  const input = positionalInput(game)
  const move = input.moves.find((entry) => entry.id === "d8e7")
  assert.ok(move)
  const support = move.outcome.support?.addedFriendlySupport.find(
    (entry) => entry.target.piece === "q"
  )
  assert.ok(support)
  assert.equal(support.wasThreatened, true)
  assert.equal(support.beforeCount, 0)
  assert.equal(support.afterCount, 1)
  assert.ok(
    legalMoves(applyMove(game, move.id)).some((reply) => reply.id === "d1d6")
  )
  assert.ok(
    !move.outcome.relationships?.resolvedThreats.some(
      (entry) => entry.piece === "q"
    )
  )
  const card = buildSharedPrompt(input).choices.find(
    (choice) => choice.id === move.id
  )
  assert.ok(card)
  assert.match(card.outcome, /adds protection to attacked queen d6 \(0->1\)/)
  assert.doesNotMatch(card.outcome, /SAVES QUEEN|RESCUE|rescued/)
})

test("an extra defender for an already protected unattacked queen is omitted as low-signal context", () => {
  const input = positionalInput(fromFen("3b3k/8/r2q4/8/8/8/8/7K b - - 0 40"))
  const move = input.moves.find((entry) => entry.id === "d8e7")
  assert.ok(move)
  const support = move.outcome.support?.addedFriendlySupport.find(
    (entry) => entry.target.piece === "q"
  )
  assert.ok(support)
  assert.equal(support.wasThreatened, false)
  assert.equal(support.beforeCount, 1)
  assert.equal(support.afterCount, 2)
  assert.doesNotMatch(contextOf(input, move.id), /adds protection/)
})

test("full near-file cover retains the focused castle preference, including ordinary g6 and h6 pawn structures", () => {
  for (const fen of [
    "r3k2r/ppp2p1p/6p1/8/8/8/8/4K3 b k - 0 40",
    "r3k2r/ppp2pp1/7p/8/8/8/8/4K3 b k - 0 40"
  ]) {
    const input = positionalInput(fromFen(fen))
    const castle = input.moves.find((move) => move.id === "e8g8")
    assert.ok(castle)
    assert.equal(castle.outcome.kingCover?.landing?.nearFiles.length, 3)
    const result = buildSharedPrompt(input)
    assert.match(result.prompt, /CASTLING CHECK BEFORE YOUR ANSWER/)
    assert.ok(
      result.prompt.includes(
        `Prefer these castles over quiet moves, non-winning checks or equal trades: ${moveChoiceLabel(castle)}.`
      )
    )
    assert.match(
      result.prompt,
      /Override for mate, stopping mate, queen rescue/
    )
    assert.deepEqual(
      result.choices.map((choice) => choice.id),
      input.moves.map((move) => move.id)
    )
  }
})

test("thin or empty landing cover stays legal and factual without a hard castle reminder", () => {
  for (const [fen, near] of [
    ["r3k2r/ppp2p2/7p/6p1/8/8/8/4K3 b k - 0 40", 2],
    ["r3k2r/8/8/8/8/8/8/4K3 b k - 0 40", 0]
  ] as const) {
    const input = positionalInput(fromFen(fen))
    const castle = input.moves.find((move) => move.id === "e8g8")
    assert.ok(castle)
    assert.equal(castle.outcome.kingCover?.landing?.nearFiles.length, near)
    const result = buildSharedPrompt(input)
    assert.doesNotMatch(
      result.prompt,
      /CASTLING CHECK BEFORE YOUR ANSWER|otherwise CASTLE when listed|castle if a listed castle is MATERIAL-SAFE/
    )
    assert.match(
      SHARED_SYSTEM_PROMPT,
      /castling\/development/
    )
    const card = result.choices.find((choice) => choice.id === castle.id)
    assert.ok(card)
    assert.match(card.outcome, /CASTLES kingside/)
    assert.ok(
      card.outcome.includes(`current king g8 kingside near-files ${near}`)
    )
    assert.doesNotMatch(card.outcome, /bad cover|unsafe castle|illegal/)
    assert.deepEqual(
      result.choices.map((choice) => choice.label),
      input.moves.map(moveChoiceLabel)
    )
  }
})

test("a full-cover wing can retain a preference without imposing it on the thin-cover wing", () => {
  const input = positionalInput(
    fromFen("r3k2r/ppp2p2/7p/6p1/8/8/8/4K3 b kq - 0 40")
  )
  const kingside = input.moves.find((move) => move.id === "e8g8")
  const queenside = input.moves.find((move) => move.id === "e8c8")
  assert.ok(kingside && queenside)
  const result = buildSharedPrompt(input)
  const preference = result.prompt
    .split("\n")
    .find((line) => line.startsWith("Prefer these castles over"))
  assert.ok(preference)
  assert.ok(preference.includes(moveChoiceLabel(queenside)))
  assert.ok(!preference.includes(moveChoiceLabel(kingside)))
  assert.ok(result.choices.some((choice) => choice.id === kingside.id))
})

test("historical annotations without landing cover preserve the earlier castle hint without inventing a cover count", () => {
  const game = fromFen("r3k2r/8/8/8/8/8/8/4K3 b k - 0 40")
  const input = {
    game,
    moves: annotatedLegalMoves(game, {
      relationships: true,
      mobility: true,
      safety: true,
      castling: true
    }),
    currentThreats: currentThreats(game)
  }
  const result = buildSharedPrompt(input)
  assert.match(result.prompt, /CASTLING CHECK BEFORE YOUR ANSWER/)
  assert.doesNotMatch(result.prompt, /near-files 3/)
})

function winningInput(fen: string): SharedPromptInput {
  const game = fromFen(fen)
  return {
    game,
    moves: annotatedLegalMoves(game, {
      relationships: true,
      mobility: true,
      support: true,
      castling: true,
      kingCover: true,
      promotionReplies: true,
      kingMobility: true,
      safety: true
    }),
    currentThreats: currentThreats(game)
  }
}

test("quiet unanswered promotions show all four roles and net loss before other positional cues", () => {
  const input = winningInput("8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72")
  const context = contextOf(input, "h4f2")
  assert.match(
    context,
    /^promotion risk: White h7-h8, no Black capture, net Q-8\/R-4\/B-2\/N-2/
  )
  assert.doesNotMatch(context, /king legal destinations|king square distance/)
  const material =
    positiveSafetySummaries(input).find((line) =>
      line.startsWith("MATERIAL-SAFE CHOICES")
    ) ?? ""
  const risky = input.moves.find((move) => move.id === "h4f2")
  assert.ok(risky)
  assert.ok(!material.includes(moveChoiceLabel(risky)))
})

test("recapturable or compensated promotions are not mislabeled as unanswered losses", () => {
  const input = winningInput("8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72")
  const context = contextOf(input, "a2b1")
  assert.match(
    context,
    /promotion: White h7-h8, Black capture available \(queen h4\), best net Q\+1\/R\+1\/B\+1\/N\+1/
  )
  assert.doesNotMatch(context, /promotion risk/)
  const compensated = winningInput("8/6P1/8/r7/Q7/8/k7/6K1 b - - 0 40")
  const gain = contextOf(compensated, "a5a4")
  assert.match(gain, /White g7-g8/)
  assert.match(gain, /Q\(check\)\+1/)
  assert.doesNotMatch(gain, /promotion risk/)
})

test("underpromotion checking and mating statuses are actual reply facts without changing our action enum", () => {
  const check = winningInput("8/p5P1/7k/8/8/8/8/K7 b - - 0 40")
  const context = contextOf(check, "a7a6")
  assert.match(context, /N\(check\)/)
  assert.doesNotMatch(context, /Q\(check\)/)
  const mate = winningInput("7k/p4P2/6K1/8/8/8/8/8 b - - 0 40")
  const mating = contextOf(mate, "a7a6")
  assert.match(mating, /Q\(mate\)/)
  assert.match(mating, /R\(mate\)/)
  assert.doesNotMatch(mating, /king legal destinations/)
  assert.deepEqual(
    buildSharedPrompt(mate).choices.map((choice) => choice.label),
    mate.moves.map(moveChoiceLabel)
  )
})

test("queen and rook king restrictions show destinations and remaining replies without inferring mate", () => {
  const queen = winningInput("7K/8/2k5/3q4/8/8/8/8 b - - 0 40")
  assert.match(
    contextOf(queen, "d5d7"),
    /White king legal destinations \[h7,g7\]->\[g8\] \(2->1\); other legal replies 0/
  )
  const rook = winningInput("7K/8/5k2/r7/8/8/8/8 b - - 0 40")
  assert.match(contextOf(rook, "a5a7"), /king legal destinations \[h7,g8\]->\[g8\] \(2->1\)/)
  const box = winningInput("7K/8/2k5/3q4/8/8/P7/8 b - - 0 40")
  const boxed = contextOf(box, "d5f7")
  assert.match(boxed, /destinations \[h7,g7\]->\[none\] \(2->0\)/)
  assert.match(boxed, /other legal replies 2/)
  assert.doesNotMatch(boxed, /mate|win/)
})

test("bare-king approach reports geometry and terminal or losing checks never gain confinement praise", () => {
  const input = winningInput("7K/8/2k5/3q4/8/8/8/8 b - - 0 40")
  assert.match(
    contextOf(input, "c6d7"),
    /Black king square distance to bare White king 5->4/
  )
  const sacrifice = contextOf(input, "d5g8")
  assert.doesNotMatch(sacrifice, /king legal destinations|king square distance/)
  const stale = buildSharedPrompt(input).choices.find(
    (choice) => choice.id === "d5f7"
  )
  assert.ok(stale)
  assert.match(stale.outcome, /STALEMATE: draw now/)
  assert.doesNotMatch(
    stale.outcome,
    /CONTEXT|king legal destinations|king square distance/
  )
  const opening = applyMove(newGame("white"), "e2e4")
  const full = {
    game: opening,
    moves: annotatedLegalMoves(opening, {
      relationships: true,
      mobility: true,
      safety: true,
      promotionReplies: true,
      kingMobility: true
    }),
    currentThreats: currentThreats(opening)
  }
  assert.doesNotMatch(
    buildSharedPrompt(full).prompt,
    /White king legal destinations/
  )
})

test("material and promotion danger suppress positive confinement even when geometry restricts a king", () => {
  const input = winningInput("7K/8/2k5/3q4/8/8/8/8 b - - 0 40")
  const target = input.moves.find((move) => move.id === "d5d7")
  assert.ok(target)
  const loss = {
    ...input,
    moves: input.moves.map((move) =>
      move.id === target.id
        ? {
            ...move,
            outcome: {
              ...move.outcome,
              replyMaterialLosses: [
                {
                  piece: "q" as const,
                  square: move.path[1],
                  capturedBy: { piece: "k" as const, square: 7 },
                  netMaterial: -9
                }
              ]
            }
          }
        : move
    )
  }
  assert.doesNotMatch(
    contextOf(loss, target.id),
    /king legal destinations|king square distance/
  )
  const promotion = {
    ...input,
    moves: input.moves.map((move) =>
      move.id === target.id
        ? {
            ...move,
            outcome: {
              ...move.outcome,
              promotionReplies: [
                {
                  id: "h7h8q",
                  from: 15,
                  to: 7,
                  promotion: "q" as const,
                  check: false,
                  checkmate: false,
                  capturableBy: [],
                  netAfterPromotion: -8
                }
              ]
            }
          }
        : move
    )
  }
  assert.match(contextOf(promotion, target.id), /^promotion risk/)
  assert.doesNotMatch(
    contextOf(promotion, target.id),
    /king legal destinations|king square distance/
  )
})

test("tactical focus retains every card and risk while omitting soft opening, support and cover distractions", () => {
  const input = winningInput(
    "rBb1kbnN/4p1pp/1pp5/pq6/8/1PP2QP1/P3NP1P/R3K2R b KQq - 0 17"
  )
  const result = buildSharedPrompt(input)
  assert.ok(result.choices.some((choice) => choice.id === "a8b8"))
  assert.doesNotMatch(result.prompt, /CONTEXT: .*frees blocked bishop/)
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.label),
    input.moves.map(moveChoiceLabel)
  )
  const labelsOnly = annotatedLegalMoves(input.game).map(moveChoiceLabel)
  assert.deepEqual(
    result.choices.map((choice) => choice.label),
    labelsOnly
  )
})

test("winning context remains within the existing row budget and does not mutate the snapshot", () => {
  for (const fen of [
    "8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72",
    "7K/8/2k5/3q4/8/8/8/8 b - - 0 40"
  ]) {
    const input = winningInput(fen),
      saved = JSON.stringify(input)
    const result = buildSharedPrompt(input)
    for (const choice of result.choices) {
      const context = choice.outcome.split("; CONTEXT: ")[1] ?? ""
      assert.ok(context.length <= 180)
    }
    assert.equal(JSON.stringify(input), saved)
  }
})

test("tactical focus covers check, current queen threats and mating replies while keeping actual attacked-piece support", () => {
  const queen = winningInput("3b3k/8/3q4/8/8/8/8/3R3K b - - 0 40")
  const defended = contextOf(queen, "d8e7")
  assert.match(defended, /adds protection to attacked queen/)
  const source = positionalInput(applyMove(newGame("white"), "e2e4"))
  const checked = { ...source, game: { ...source.game, inCheck: true } }
  assert.doesNotMatch(
    contextOf(checked, "e7e5"),
    /frees blocked bishop|central pawn|future castle/
  )
  const first = source.moves[0]
  assert.ok(first)
  const mateRisk = {
    ...source,
    moves: source.moves.map((move) =>
      move.id === first.id
        ? { ...move, outcome: { ...move.outcome, allowsMateInOne: true } }
        : move
    )
  }
  assert.doesNotMatch(
    contextOf(mateRisk, "e7e5"),
    /frees blocked bishop|central pawn|future castle/
  )
  const target = source.moves.find((move) => move.id === "e7e5")
  assert.ok(target)
  const newlyLost = {
    ...mateRisk,
    moves: mateRisk.moves.map((move) =>
      move.id === target.id
        ? {
            ...move,
            outcome: {
              ...move.outcome,
              castling: {
                lostRights: [
                  { side: "ai" as const, wing: "queenside" as const }
                ],
                paths: []
              }
            }
          }
        : move
    )
  }
  assert.match(
    contextOf(newlyLost, target.id),
    /queenside castling rights: held->gone/
  )
})

test("current queen urgency omits soft unthreatened support while preserving all legal facts and labels", () => {
  const source = positionalInput(fromFen("3b3k/8/3q4/8/8/8/8/7K b - - 0 40"))
  assert.match(contextOf(source, "d8e7"), /adds protection to queen/)
  const threat = {
    target: { piece: "q" as const, square: 19 },
    attackers: [{ piece: "r" as const, square: 59 }]
  }
  const urgent = { ...source, currentThreats: [threat] }
  assert.doesNotMatch(contextOf(urgent, "d8e7"), /adds protection/)
  assert.deepEqual(
    buildSharedPrompt(urgent).choices.map((choice) => choice.id),
    source.moves.map((move) => move.id)
  )
})

const openingAdvice =
  "Central pawn pushes gain space and can free bishops or knights."
const coverAdvice =
  "Near-files counts pawn files on the two pawn ranks nearest home. Balance cover with space, piece activity and castling; no material score or pawn-move ban."
const promotionAdvice =
  "Answer promotion threats unless legal recaptures or material gains compensate."
const coordinationAdvice =
  "Coordinate king and major pieces to restrict the enemy king; keep material, avoid stalemate. Destination counts alone do not prove mate."

function fullInput(game: ReturnType<typeof newGame>): SharedPromptInput {
  return {
    game,
    moves: annotatedLegalMoves(game, {
      relationships: true,
      mobility: true,
      safety: true,
      support: true,
      castling: true,
      kingCover: true,
      promotionReplies: true,
      kingMobility: true
    }),
    currentThreats: currentThreats(game)
  }
}

const tacticalPriorityV18 =
  "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; take safe material gains, including forcing checks that win material."
const tacticalPriorityV15 =
  "Priorities: CHECKMATE now; prevent White's mate and answer check; save a threatened queen or take a free queen; take safe material gains, including forcing checks that win material; otherwise CASTLE when listed; otherwise develop a knight/bishop or advance a central pawn."
const tacticalFallbackV18 =
  "After addressing the king and any attacked queen, prefer a MATERIAL-SAFE material gain or a forcing material-winning check over a quiet move."
const tacticalFallbackV15 =
  "After addressing the king and any attacked queen, prefer a MATERIAL-SAFE choice. When there is no urgent threat, castle if a listed castle is MATERIAL-SAFE."

function normalizeIntentionalTacticalDifferences(prompt: string, input: SharedPromptInput): string {
  return restoreLegacyUserLayout(prompt, false, input)
    .replace(tacticalPriorityV18, tacticalPriorityV15)
    .replace(tacticalFallbackV18, tacticalFallbackV15)
    .replace(
      /; CONTEXT: (?:kingside and queenside|kingside|queenside) castling rights: held->gone/g,
      ""
    )
}

const v15TacticalControls = [
  {
    name: "a6 bishop opening",
    game: () =>
      ["e2e4", "g7g6", "f2f3", "b8c6", "f1a6"].reduce(applyMove, newGame("white")),
    hash: "e1a6888aba6085c7e52818f273ef876e7384d177a7288ecbab88ba477634f124"
  },
  {
    name: "knight capture or forcing pawn check",
    game: () =>
      fromFen("1B2kbnN/4p1pp/1pp5/2q2N2/8/2P3P1/R2K1P1P/7R b - - 0 25"),
    hash: "488c63b2bd1a225db827685b33a69d57b1ecf034fddebee1d6452258429ff9e4"
  },
  {
    name: "free queen",
    game: () => fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 40"),
    hash: "6409373f8650e0916b672442adc1e4c64dec60c6b2ec636224b878458470ba73"
  }
]

for (const control of v15TacticalControls) {
  test(`tactical ${control.name} retains V15 user facts without unrelated global coaching`, () => {
    const input = fullInput(control.game()),
      result = buildSharedPrompt(input)
    assert.equal(
      createHash("sha256")
        .update(normalizeIntentionalTacticalDifferences(result.prompt, input))
        .digest("hex"),
      control.hash
    )
    for (const advice of [
      openingAdvice,
      coverAdvice,
      promotionAdvice,
      coordinationAdvice
    ])
      assert.ok(!result.prompt.includes(advice))
    assert.match(SHARED_SYSTEM_PROMPT, /Take a listed CHECKMATE now\. Otherwise stop White's mate or answer check/)
    assert.ok(!result.prompt.split("\n").some((line) => line.startsWith("Take a listed CHECKMATE")))
    assert.ok(result.prompt.includes("Within the king/queen-safe choices, prefer MATERIAL-SAFE captures or forcing gains to quiet moves or non-winning checks."))
    assert.doesNotMatch(tacticalPriorityV18, /castle|develop/i)
    const material = positiveSafetySummaries(input).find((line) =>
      line.startsWith("MATERIAL-SAFE CHOICES")
    )
    assert.ok(material)
    assert.match(
      material,
      /No checked immediate capture exchange loses Black material; White has no mate in one/
    )
    assert.doesNotMatch(material, /promotion/)
    assert.deepEqual(
      result.choices.map((choice) => choice.id),
      input.moves.map((move) => move.id)
    )
    assert.deepEqual(
      result.choices.map((choice) => choice.label),
      input.moves.map(moveChoiceLabel)
    )
  })
}

test("quiet early pawn-cover positions retain opening and cover advice only while relevant", () => {
  const game = ["e2e4", "h7h6", "g1f3", "g7g5", "f1c4"].reduce(
    applyMove,
    newGame("white")
  )
  const result = buildSharedPrompt(fullInput(game))
  assert.ok(result.prompt.includes(openingAdvice))
  assert.ok(result.prompt.includes(coverAdvice))
  assert.ok(!result.prompt.includes(promotionAdvice))
  assert.ok(!result.prompt.includes(coordinationAdvice))
  assert.match(result.prompt, /near-files/)
  assert.match(
    SHARED_SYSTEM_PROMPT,
    /castling\/development/
  )
  const later = fromFen(game.fen.replace(/\d+$/, "40"))
  const lateResult = buildSharedPrompt(fullInput(later))
  assert.ok(!lateResult.prompt.includes(openingAdvice))
  assert.ok(lateResult.prompt.includes(coverAdvice))
})

test("bare boxed-king guidance uses raw phase metadata even with no positive context rows", () => {
  const input = fullInput(fromFen("7K/5q2/2k5/8/8/8/8/8 b - - 0 40"))
  const result = buildSharedPrompt(input)
  assert.ok(
    input.moves.every((move) => move.outcome.kingMobility?.opponentBareKing)
  )
  assert.ok(
    result.choices.every(
      (choice) =>
        !/king legal destinations|king square distance/.test(choice.outcome)
    )
  )
  assert.ok(result.prompt.includes(coordinationAdvice))
  assert.ok(!result.prompt.includes(openingAdvice))
  assert.ok(!result.prompt.includes(coverAdvice))
  assert.ok(!result.prompt.includes(promotionAdvice))
  const stale = result.choices.find((choice) => choice.id === "c6d6")
  assert.ok(stale)
  assert.match(stale.outcome, /STALEMATE: draw now/)
  assert.doesNotMatch(stale.outcome, /CONTEXT/)
})

test("actual promotion emergencies retain factual warnings and scoped advice while muting unrelated research", () => {
  const input = fullInput(fromFen("8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72"))
  const result = buildSharedPrompt(input)
  assert.ok(result.prompt.includes(promotionAdvice))
  assert.ok(!result.prompt.includes(openingAdvice))
  assert.ok(!result.prompt.includes(coverAdvice))
  assert.ok(!result.prompt.includes(coordinationAdvice))
  const bad = result.choices.find((choice) => choice.id === "h4f2")
  const answered = result.choices.find((choice) => choice.id === "a2b1")
  assert.ok(bad && answered)
  assert.match(bad.outcome, /CONTEXT: promotion risk/)
  assert.match(answered.outcome, /Black capture available/)
  assert.doesNotMatch(answered.outcome, /promotion risk/)
  const material = positiveSafetySummaries(input).find((line) =>
    line.startsWith("MATERIAL-SAFE CHOICES")
  )
  assert.ok(material)
  assert.match(material, /capture or promotion reply/)
})

test("immediate Black mate suppresses global promotion coaching without erasing other legal reply facts", () => {
  const input = fullInput(
    fromFen("rnbqkbnr/pPpp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2")
  )
  assert.ok(input.moves.some((move) => move.outcome.checkmate))
  assert.ok(
    input.moves.some((move) => (move.outcome.promotionReplies?.length ?? 0) > 0)
  )
  const result = buildSharedPrompt(input)
  assert.ok(!result.prompt.includes(promotionAdvice))
  assert.match(result.prompt, /Black can WIN THIS TURN/)
  assert.ok(
    result.choices.some((choice) => choice.outcome.includes("promotion risk"))
  )
  assert.deepEqual(
    result.choices.map((choice) => choice.id),
    input.moves.map((move) => move.id)
  )
})


test("mate-versus-stalemate reminder is present only when both terminal outcomes are available", () => {
  const terminal = fullInput(fromFen("8/8/8/8/5q2/8/5k2/7K b - - 0 40"))
  assert.ok(terminal.moves.some(move => move.outcome.checkmate))
  assert.ok(terminal.moves.some(move => move.outcome.stalemate))
  assert.match(buildSharedPrompt(terminal).prompt, /Choose a win; avoid STALEMATE \(draw\)\./)
  const quiet = fullInput(newGame("white"))
  assert.doesNotMatch(buildSharedPrompt(quiet).prompt, /Choose a win; avoid STALEMATE/)
})

test("actual model inputs use you/opponent ownership and light/dark for both assignments", () => {
  for (const humanColor of ["white", "black"] as const) {
    const ids = humanColor === "white" ? ["e2e4"] : ["e2e4", "e7e5"]
    const game = ids.reduce(applyMove, newGame(humanColor))
    const input = fullInput(game)
    const result = buildPlayerPrompt(input)
    assert.equal(result.systemPrompt, systemPromptFor(game))
    assert.ok(result.prompt.includes(`Position FEN: ${game.fen}\n`))
    const ownTone = humanColor === "white" ? "dark" : "light"
    const otherTone = ownTone === "dark" ? "light" : "dark"
    const ownKing = humanColor === "white" ? "e8" : "e1"
    const otherKing = ownKing === "e8" ? "e1" : "e8"
    assert.ok(result.systemPrompt.startsWith(`You control the ${ownTone} chess pieces.`))
    assert.ok(result.prompt.includes(`Your pieces (${ownTone}):\nKing: ${ownKing}`))
    assert.ok(result.prompt.includes(`Opponent's pieces (${otherTone}):\nKing: ${otherKing}`))
    assert.doesNotMatch(result.systemPrompt + result.prompt, /\b(?:black|white)\b/i)
    assert.doesNotMatch(result.systemPrompt + result.prompt, /that your|no your|opponent's moves next/)
    assert.deepEqual(result.choices.map(choice => choice.id), input.moves.map(move => move.id))
    for (const choice of result.choices) assert.ok(result.prompt.includes(choice.outcome))
    const recent = game.history.slice(-8).map(move => `${move.side === "ai" ? "You" : "Opponent"}: ${move.notation} (${move.id})`)
    assert.ok(result.prompt.includes(recent.join("\n")))
    for (const model of ["prompt-api", "apple-foundationmodel", "LiquidAI/LFM3-1.7B-GGUF", "unsloth/Qwen3.5-2B-GGUF"] as const)
      for (const thinking of [false, true])
        assert.deepEqual(buildPlayerPrompt({ ...input, game: { ...game, opponent: { model, thinking } } }), result)
  }
})
