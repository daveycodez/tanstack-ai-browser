import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildCompactChoices,
  immediateOpportunityHighlights,
  buildStyledPrompt,
  DEFAULT_PROMPT_STYLE,
  defaultPromptStyleFor,
  PROMPT_STYLES,
  shouldUseCastlingFocus
} from "./prompt-options.ts"
import type { PromptStyleInput } from "./prompt-options.ts"
import {
  annotatedLegalMoves,
  applyMove,
  currentThreats,
  fromFen,
  newGame
} from "./chess.ts"
import type { Game } from "./chess.ts"
import { describePosition } from "./ai-position.ts"

const input: PromptStyleInput = {
  baselinePrompt: "Original prompt\nwith exact spacing.  ",
  board: "Black pieces: King e8, queen d8. White king e1.",
  choices: [
    { id: "e8g8", outcome: "e8g8: king e8-g8; outcome: castles kingside" },
    {
      id: "d8h4",
      outcome: "d8h4: queen d8-h4; outcome: CHECKMATE, wins immediately"
    },
    { id: "e8c8", outcome: "e8c8: king e8-c8; outcome: castles queenside" }
  ],
  recentMoves: ["White: f3 (f2f3)"],
  currentThreats: [
    "Black queen (9) on d8 can be captured by White bishop (3) on a5."
  ],
  castlingMoves: [
    { id: "e8g8", wing: "kingside" },
    { id: "e8c8", wing: "queenside" }
  ],
  inCheck: false,
  queenValue: 9,
  thinking: false
}

test("baseline style retains its exact prompt bytes and remains the default", () => {
  assert.equal(DEFAULT_PROMPT_STYLE, "baseline")
  assert.equal(buildStyledPrompt("baseline", input), input.baselinePrompt)
  assert.deepEqual(
    PROMPT_STYLES.map((style) => style.id),
    [
      "baseline",
      "casual",
      "structured",
      "compact",
      "compact-castle",
      "compact-safe-castle",
      "compact-highlights",
      "compact-copy"
    ]
  )
})

for (const style of ["casual", "structured"] as const) {
  test(`${style} preserves all choices and their order, with explicit legal castling and urgent tactics`, () => {
    const prompt = buildStyledPrompt(style, input)
    let previous = -1
    for (const choice of input.choices) {
      const index = prompt.indexOf(choice.outcome)
      assert.ok(index > previous)
      assert.equal(prompt.split(choice.outcome).length, 2)
      previous = index
    }
    assert.match(prompt, /kingside: e8g8; queenside: e8c8/)
    assert.match(
      prompt,
      /Take an immediate CHECKMATE, even when you can castle/
    )
    assert.match(
      prompt,
      /Otherwise, castle when a legal castling move is listed/
    )
    assert.match(
      prompt,
      /Black queen \(9\) on d8 can be captured by White bishop \(3\) on a5/
    )
    assert.match(prompt, /does not make a piece immune/)
    assert.match(prompt, /A check or capture is not automatically better/)
    assert.match(prompt, /Stop after that object's closing brace/)
  })

  test(`${style} distinguishes castling rights from current legality and does not invent threats`, () => {
    const prompt = buildStyledPrompt(style, {
      ...input,
      castlingMoves: [],
      currentThreats: [],
      inCheck: true
    })
    assert.match(prompt, /Castling rights alone do not mean castling is legal/)
    assert.match(prompt, /Black in check now: yes/)
    assert.match(prompt, /No current legal capture of a Black non-king piece/)
    assert.match(prompt, /none/)
    assert.doesNotMatch(prompt, /Use your thinking for a short comparison/)
    assert.match(
      buildStyledPrompt(style, { ...input, thinking: true }),
      /Use your thinking for a short comparison/
    )
  })
}

function compactInput(game: Game): PromptStyleInput {
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true
  })
  return {
    ...input,
    moves,
    board: describePosition(game),
    currentThreatData: currentThreats(game),
    currentThreats: [],
    choices: [...moves]
      .reverse()
      .map((move) => ({ id: move.id, outcome: move.notation })),
    inCheck: game.inCheck,
    castlingMoves: moves.flatMap((move) =>
      move.notation.startsWith("O-O")
        ? [
            {
              id: move.id,
              wing: move.notation.startsWith("O-O-O")
                ? ("queenside" as const)
                : ("kingside" as const)
            }
          ]
        : []
    )
  }
}

test("compact cards keep every legal choice exactly once and in supplied order, including terminal alternatives", () => {
  const game = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())
  const data = compactInput(game)
  const cards = buildCompactChoices(data)
  assert.deepEqual(
    cards.map((card) => card.id),
    data.choices.map((choice) => choice.id)
  )
  const mate = cards.find((card) => card.id === "d8h4")
  assert.ok(mate)
  assert.equal(mate.outcome, "d8h4 | queen d8-h4 | CHECKMATE: wins now")
  const prompt = buildStyledPrompt("compact", { ...data, choices: cards })
  let previous = -1
  for (const card of cards) {
    const index = prompt.indexOf(card.outcome)
    assert.ok(index > previous)
    assert.equal(prompt.split(card.outcome).length, 2)
    previous = index
  }
  assert.doesNotMatch(mate.outcome, /CASTLE|CAPTURABLE|RECAPTURED|SAVES QUEEN/)
  assert.match(prompt, /otherwise CASTLE when listed/)
})

test("compact queen-saving labels distinguish resolved threats from an exposed stationary or moved queen", () => {
  const data = compactInput(fromFen("r5k1/5ppp/8/3q4/4P3/8/5PPP/6K1 b - - 0 1"))
  const cards = buildCompactChoices(data)
  const escape = cards.find((card) => card.id === "d5h5")
  const ignored = cards.find((card) => card.id === "g7g6")
  const exposed = cards.find((card) => card.id === "d5f5")
  assert.ok(escape && ignored && exposed)
  assert.match(escape.outcome, /SAVES QUEEN FROM IMMEDIATE CAPTURE on h5/)
  assert.doesNotMatch(escape.outcome, /STILL IMMEDIATELY CAPTURABLE/)
  assert.match(ignored.outcome, /QUEEN STILL IMMEDIATELY CAPTURABLE on d5/)
  assert.match(exposed.outcome, /QUEEN STILL IMMEDIATELY CAPTURABLE on f5/)
  assert.doesNotMatch(exposed.outcome, /SAVES QUEEN/)
})

test("compact cards spell out a conditional queen-for-rook loss and an immediate unrecapturable capture", () => {
  const trade = buildCompactChoices(
    compactInput(fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1"))
  )
  const queen = trade.find((card) => card.id === "d8d4")
  assert.ok(queen)
  assert.match(queen.outcome, /CAPTURES rook \(5\)/)
  assert.match(queen.outcome, /IF RECAPTURED NEXT TURN: loses 4 material/)
  assert.doesNotMatch(queen.outcome, /CANNOT BE LEGALLY RECAPTURED/)
  const free = buildCompactChoices(
    compactInput(fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1"))
  )
  const pawn = free.find((card) => card.id === "e5d4")
  assert.ok(pawn)
  assert.match(
    pawn.outcome,
    /CAPTURES queen \(9\); MOVED PIECE CANNOT BE LEGALLY RECAPTURED NEXT TURN/
  )
})

test("compact cards distinguish legal castling, simple development and stalemate from future outcomes", () => {
  const castleData = compactInput(
    fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
  )
  const cards = buildCompactChoices(castleData)
  const castle = cards.find((card) => card.id === "e8g8")
  assert.ok(castle)
  assert.match(castle.outcome, /CASTLES kingside/)
  assert.match(
    buildStyledPrompt("compact", { ...castleData, choices: cards }),
    /Legal CASTLE IDs now: .*e8g8/
  )
  const opening = buildCompactChoices(
    compactInput(applyMove(newGame(), "e2e4"))
  )
  assert.match(
    opening.find((card) => card.id === "b8c6")?.outcome ?? "",
    /KNIGHT LEAVES HOME SQUARE/
  )
  assert.match(
    opening.find((card) => card.id === "d7d5")?.outcome ?? "",
    /PAWN ADVANCES ON CENTRAL FILE/
  )
  const stale = buildCompactChoices(
    compactInput(fromFen("8/8/8/8/5q2/8/5k2/7K b - - 0 1"))
  ).find((card) => card.id === "f4g3")
  assert.ok(stale)
  assert.equal(stale.outcome, "f4g3 | queen f4-g3 | STALEMATE: draw now")
})

test("compact castling focus retains identical cards and adds a factual reminder immediately before the answer", () => {
  const data = compactInput(fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"))
  const cards = buildCompactChoices(data)
  const promptInput = { ...data, choices: cards }
  const compact = buildStyledPrompt("compact", promptInput)
  const focused = buildStyledPrompt("compact-castle", promptInput)
  const focusIndex = focused.indexOf("CASTLING CHECK BEFORE YOUR ANSWER:")
  const answerIndex = focused.indexOf("Return exactly one JSON object:")
  assert.ok(focusIndex > focused.indexOf(cards[cards.length - 1].outcome))
  assert.ok(answerIndex > focusIndex)
  assert.doesNotMatch(compact, /CASTLING CHECK BEFORE YOUR ANSWER/)
  let previous = -1
  for (const card of cards) {
    const index = focused.indexOf(card.outcome)
    assert.ok(index > previous)
    assert.equal(focused.split(card.outcome).length, 2)
    previous = index
  }
  for (const castle of data.castlingMoves)
    assert.ok(focused.includes(`${castle.wing} ${castle.id}`))
  assert.match(
    focused,
    /prefer it over quiet moves, non-winning checks, and equal trades/
  )
  assert.match(
    focused,
    /win immediately, prevent White's immediate mate, save an attacked queen, capture a free queen/
  )
  assert.match(focused, /clearly favorable material capture/)
  assert.match(
    focused,
    /A capture marked as losing material if recaptured is not a clearly favorable trade/
  )
  assert.doesNotMatch(
    focused,
    /must choose e8|only allowed move|remove other choices/
  )
})

test("compact castling focus cannot invent a castle or override terminal and queen priorities", () => {
  const data = compactInput(
    ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())
  )
  const cards = buildCompactChoices(data)
  const focused = buildStyledPrompt("compact-castle", {
    ...data,
    choices: cards,
    currentThreats: [
      "Black queen (9) on d8 can be captured by White bishop (3) on a5."
    ]
  })
  assert.match(focused, /Legal castle choices in this position: none/)
  assert.match(focused, /If no castle is listed, use the normal priorities/)
  assert.match(focused, /d8h4 \| queen d8-h4 \| CHECKMATE: wins now/)
  assert.match(
    focused,
    /Black queen \(9\) on d8 can be captured by White bishop \(3\) on a5/
  )
  assert.match(
    focused,
    /save a threatened queen or take a free queen; otherwise CASTLE/
  )
  assert.match(focused, /save an attacked queen/)
})

function safeCastleInput(): PromptStyleInput {
  const data = compactInput(
    fromFen("r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R b KQkq - 0 1")
  )
  return { ...data, choices: buildCompactChoices(data) }
}

test("conditional castling style is exactly the strong focus only for ordinary positions without urgent facts", () => {
  const data = safeCastleInput()
  assert.equal(shouldUseCastlingFocus(data), true)
  assert.equal(
    buildStyledPrompt("compact-safe-castle", data),
    buildStyledPrompt("compact-castle", data)
  )
  assert.notEqual(
    buildStyledPrompt("compact-safe-castle", data),
    buildStyledPrompt("compact", data)
  )
  const cards = buildCompactChoices(data)
  assert.deepEqual(
    cards.map((card) => card.id),
    data.choices.map((choice) => choice.id)
  )
})

test("conditional castling is byte-identical to compact for no castle, check, or an attacked queen", () => {
  const data = safeCastleInput()
  const variants: PromptStyleInput[] = [
    { ...data, castlingMoves: [] },
    { ...data, inCheck: true },
    {
      ...data,
      currentThreatData: [
        {
          target: { piece: "q", square: 3 },
          attackers: [{ piece: "p", square: 12 }]
        }
      ]
    },
    { ...data, moves: undefined }
  ]
  for (const variant of variants) {
    assert.equal(shouldUseCastlingFocus(variant), false)
    assert.equal(
      buildStyledPrompt("compact-safe-castle", variant),
      buildStyledPrompt("compact", variant)
    )
  }
})

test("conditional castling is byte-identical to compact for immediate mates, opponent mating replies, or clear valuable captures", () => {
  const data = safeCastleInput()
  const move = data.moves?.[0]
  assert.ok(move)
  const urgentMoves = [
    { ...move, outcome: { ...move.outcome, checkmate: true } },
    { ...move, outcome: { ...move.outcome, allowsMateInOne: true } },
    {
      ...move,
      captured: "n" as const,
      outcome: { ...move.outcome, recapture: { count: 0 } }
    },
    {
      ...move,
      captured: "q" as const,
      outcome: { ...move.outcome, recapture: { count: 0 } }
    }
  ]
  for (const urgent of urgentMoves) {
    const variant = { ...data, moves: [urgent, ...(data.moves ?? []).slice(1)] }
    assert.equal(shouldUseCastlingFocus(variant), false)
    assert.equal(
      buildStyledPrompt("compact-safe-castle", variant),
      buildStyledPrompt("compact", variant)
    )
  }
  const pawnOnly = {
    ...data,
    moves: [
      {
        ...move,
        captured: "p" as const,
        outcome: { ...move.outcome, recapture: { count: 0 } }
      }
    ]
  }
  assert.equal(shouldUseCastlingFocus(pawnOnly), true)
  const defendedRook = {
    ...data,
    moves: [
      {
        ...move,
        captured: "r" as const,
        outcome: { ...move.outcome, recapture: { count: 1 } }
      }
    ]
  }
  assert.equal(shouldUseCastlingFocus(defendedRook), true)
})

test("only the evaluated LFM3 GGUF model receives the selected casual profile", () => {
  assert.equal(
    defaultPromptStyleFor("LiquidAI/LFM3-1.7B-GGUF"),
    "compact-highlights"
  )
  assert.equal(
    defaultPromptStyleFor("onnx-community/LFM3-1.7B-ONNX"),
    "baseline"
  )
  assert.equal(defaultPromptStyleFor("prompt-api"), "baseline")
})

test("immediate highlights are byte-identical to the safe castling profile when no opportunities exist", () => {
  const data = safeCastleInput()
  assert.deepEqual(immediateOpportunityHighlights(data), [])
  assert.equal(
    buildStyledPrompt("compact-highlights", data),
    buildStyledPrompt("compact-safe-castle", data)
  )
  const noMetadata = { ...data, moves: undefined }
  assert.deepEqual(immediateOpportunityHighlights(noMetadata), [])
  assert.equal(
    buildStyledPrompt("compact-highlights", noMetadata),
    buildStyledPrompt("compact-safe-castle", noMetadata)
  )
})

test("immediate highlights list every checkmate ID in supplied choice order, retaining every card", () => {
  const data = compactInput(fromFen("8/8/8/8/5q2/8/5k2/7K b - - 0 1"))
  const cards = buildCompactChoices(data)
  const expected = data.choices
    .filter((choice) =>
      data.moves?.some(
        (move) => move.id === choice.id && move.outcome.checkmate
      )
    )
    .map((choice) => choice.id)
  assert.ok(expected.length >= 2)
  const details = { ...data, choices: cards }
  assert.ok(
    immediateOpportunityHighlights(details).includes(
      `Black can WIN THIS TURN with: ${expected.join(", ")}.`
    )
  )
  const prompt = buildStyledPrompt("compact-highlights", details)
  const heading = prompt.indexOf("AVAILABLE IMMEDIATE OPPORTUNITIES:")
  const answer = prompt.indexOf("Return exactly one JSON object:")
  assert.ok(heading > prompt.indexOf(cards[cards.length - 1].outcome))
  assert.ok(answer > heading)
  for (const card of cards) assert.equal(prompt.split(card.outcome).length, 2)
})

test("immediate queen highlights require all factual conditions and cannot invent or remove choice IDs", () => {
  const data = compactInput(
    fromFen("r5k1/5p1p/6p1/2p1p3/3Q2p1/5Q2/6PP/6K1 b - - 0 1")
  )
  const cards = buildCompactChoices(data)
  const expected = data.choices
    .filter((choice) =>
      data.moves?.some(
        (move) =>
          move.id === choice.id &&
          move.captured === "q" &&
          move.outcome.recapture.count === 0 &&
          !move.outcome.allowsMateInOne
      )
    )
    .map((choice) => choice.id)
  assert.ok(expected.length >= 2)
  const highlights = immediateOpportunityHighlights({ ...data, choices: cards })
  assert.ok(
    highlights.includes(
      `Safe queen captures (no immediate recapture or opponent mate next turn): ${expected.join(", ")}.`
    )
  )
  const missing = {
    ...data,
    choices: data.choices.filter((choice) => choice.id !== expected[0])
  }
  assert.ok(
    immediateOpportunityHighlights(missing).every(
      (line) => !line.includes(expected[0])
    )
  )
  const blocked = {
    ...data,
    moves: data.moves?.map((move) =>
      move.captured === "q"
        ? { ...move, outcome: { ...move.outcome, allowsMateInOne: true } }
        : move
    )
  }
  assert.ok(
    immediateOpportunityHighlights(blocked).every(
      (line) => !line.startsWith("Safe queen captures")
    )
  )
  const defended = {
    ...data,
    moves: data.moves?.map((move) =>
      move.captured === "q"
        ? { ...move, outcome: { ...move.outcome, recapture: { count: 1 } } }
        : move
    )
  }
  assert.ok(
    immediateOpportunityHighlights(defended).every(
      (line) => !line.startsWith("Safe queen captures")
    )
  )
  assert.deepEqual(
    buildCompactChoices(data).map((card) => card.id),
    data.choices.map((choice) => choice.id)
  )
})

test("copy-decoding profile alone changes repetition penalty and preserves the selected model default", () => {
  const copy = PROMPT_STYLES.find((style) => style.id === "compact-copy")
  assert.ok(copy)
  assert.equal(copy.repetitionPenalty, 1)
  assert.ok(
    PROMPT_STYLES.filter((style) => style.id !== "compact-copy").every(
      (style) => style.repetitionPenalty === undefined
    )
  )
  assert.equal(
    defaultPromptStyleFor("LiquidAI/LFM3-1.7B-GGUF"),
    "compact-highlights"
  )
})

test("copy-decoding prompt is byte-identical to highlights for ordinary, mating, queen-capture, and threatened-queen inputs", () => {
  const cases = [
    safeCastleInput(),
    compactInput(["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame())),
    compactInput(fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")),
    compactInput(fromFen("r5k1/5ppp/8/3q4/4P3/8/5PPP/6K1 b - - 0 1"))
  ]
  for (const data of cases) {
    const details = { ...data, choices: buildCompactChoices(data) }
    assert.equal(
      buildStyledPrompt("compact-copy", details),
      buildStyledPrompt("compact-highlights", details)
    )
  }
})
