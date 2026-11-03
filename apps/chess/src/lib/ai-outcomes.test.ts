import assert from "node:assert/strict"
import { test } from "node:test"
import { annotatedLegalMoves, applyMove, fromFen, newGame } from "./chess.ts"
import { formatMoveOutcome } from "./ai-outcomes.ts"
import type { AnnotatedMove } from "./chess.ts"
import { BASE_CONTEXT_FEATURES, CONTEXT_VARIANTS } from "./context-options.ts"

test("spells out immediate checkmate instead of relying on SAN symbols", () => {
  const game = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame("white"))
  const move = annotatedLegalMoves(game).find((move) => move.id === "d8h4")
  assert.ok(move)
  assert.match(
    formatMoveOutcome(move, "ai"),
    /^d8h4: queen d8-h4; outcome: CHECKMATE, wins immediately$/
  )
})

test("names a captured piece and states zero immediate recapturers", () => {
  const game = fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")
  const move = annotatedLegalMoves(game).find((move) => move.id === "e5d4")
  assert.ok(move)
  const text = formatMoveOutcome(move, "ai")
  assert.match(text, /captures white queen \(9\)/)
  assert.match(text, /legal recapturers: 0/)
})

test("formats a real defender count and cheapest legal recapturer", () => {
  const game = fromFen("6k1/8/8/2p1p3/3P4/2P5/8/6K1 b - - 0 1")
  const move = annotatedLegalMoves(game).find((move) => move.id === "e5d4")
  assert.ok(move)
  const text = formatMoveOutcome(move, "ai")
  assert.match(text, /captures white pawn \(1\)/)
  assert.match(text, /legal recapturers: 1, cheapest white pawn \(1\) from c3/)
})

test("keeps opening outcome lines concise enough for the existing prompt guard", () => {
  const game = applyMove(newGame("white"), "e2e4")
  const moves = annotatedLegalMoves(game)
  assert.equal(moves.length, 20)
  const text = moves.map((move) => formatMoveOutcome(move, "ai")).join("\n")
  assert.ok(text.length < 4000)
  assert.ok(
    moves.every((move) => formatMoveOutcome(move, "ai").includes("outcome:"))
  )
})

test("spells out checks, stalemates and an opponent mating reply", () => {
  const checkGame = ["e2e4", "f7f6"].reduce(applyMove, newGame("white"))
  const check = annotatedLegalMoves(checkGame).find(
    (move) => move.id === "d1h5"
  )
  assert.ok(check)
  assert.match(
    formatMoveOutcome(check, "human"),
    /outcome: CHECK, opponent must respond/
  )
  const staleGame = fromFen("8/8/8/8/5q2/8/5k2/7K b - - 0 1")
  const stale = annotatedLegalMoves(staleGame).find(
    (move) => move.id === "f4g3"
  )
  assert.ok(stale)
  assert.match(formatMoveOutcome(stale, "ai"), /STALEMATE, draw/)
  const defense = fromFen(
    "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
  )
  const unsafe = annotatedLegalMoves(defense).find((move) => move.id === "b7b6")
  assert.ok(unsafe)
  assert.match(
    formatMoveOutcome(unsafe, "ai"),
    /DANGER: opponent can CHECKMATE next turn/
  )
})

test("states conditional exchange loss without treating a promotion as a free piece", () => {
  const trade = fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1")
  const queen = annotatedLegalMoves(trade).find((move) => move.id === "d8d4")
  assert.ok(queen)
  assert.match(formatMoveOutcome(queen, "ai"), /if recaptured: net material -4/)
  const promotion = fromFen("1rk5/P7/8/8/8/8/8/7K w - - 0 1")
  const pawn = annotatedLegalMoves(promotion).find(
    (move) => move.id === "a7b8q"
  )
  assert.ok(pawn)
  assert.equal(pawn.outcome.recapture.count, 1)
  assert.match(
    formatMoveOutcome(pawn, "human"),
    /if recaptured: net material \+4/
  )
})

test("spells out castling and the actual en passant captured square", () => {
  const castling = fromFen("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
  const king = annotatedLegalMoves(castling).find((move) => move.id === "e8g8")
  assert.ok(king)
  assert.match(formatMoveOutcome(king, "ai"), /outcome: castles kingside/)
  const ep = fromFen("3r3k/8/8/3pP3/8/8/8/7K w - d6 0 1")
  const pawn = annotatedLegalMoves(ep).find((move) => move.id === "e5d6")
  assert.ok(pawn)
  assert.match(
    formatMoveOutcome(pawn, "human"),
    /captures black pawn \(1\) en passant on d5/
  )
})

test("manual queen priority changes prompt values and conditional loss without changing moves", () => {
  const trade = fromFen("3q3k/8/8/8/3R4/2B1PN2/8/7K b - - 0 1")
  const queen = annotatedLegalMoves(trade).find((move) => move.id === "d8d4")
  assert.ok(queen)
  assert.match(
    formatMoveOutcome(queen, "ai", 9),
    /if recaptured: net material -4/
  )
  assert.match(
    formatMoveOutcome(queen, "ai", 12),
    /if recaptured: net material -7/
  )
  const free = fromFen("r5k1/5ppp/8/4p3/3Q4/8/5PPP/6K1 b - - 0 1")
  const pawn = annotatedLegalMoves(free).find((move) => move.id === "e5d4")
  assert.ok(pawn)
  assert.match(formatMoveOutcome(pawn, "ai", 12), /captures white queen \(12\)/)
})

const square = (name: string) =>
  (8 - Number(name[1])) * 8 + name.charCodeAt(0) - 97

function contextFixture(): AnnotatedMove {
  const game = applyMove(newGame("white"), "e2e4")
  const move = annotatedLegalMoves(game).find((entry) => entry.id === "d7d5")
  assert.ok(move)
  return {
    ...move,
    outcome: {
      ...move.outcome,
      relationships: {
        movedPieceWasThreatened: true,
        movedPieceThreatenedBy: [
          { piece: "p", square: square("e4") },
          { piece: "b", square: square("g2") },
          { piece: "q", square: square("d1") }
        ],
        newThreats: [
          {
            target: { piece: "q", square: square("d1") },
            attackers: [{ piece: "b", square: square("g4") }]
          }
        ],
        resolvedThreats: [
          { piece: "r", square: square("a8"), fromSquare: square("a8") }
        ]
      },
      support: {
        movedPieceGeometricDefenders: [{ piece: "q", square: square("d8") }],
        conditionalRecaptures: [
          {
            captureId: "e4d5",
            attacker: { piece: "p", square: square("e4") },
            defenders: [{ piece: "q", square: square("d8") }]
          }
        ],
        addedFriendlySupport: []
      },
      mobility: {
        pawnAdvance: { squares: 2, centralSquaresControlled: [square("e4")] },
        leavesMinorHomeSquare: false,
        changedOtherPieces: [
          {
            piece: "b",
            fromSquare: square("c8"),
            square: square("c8"),
            before: 0,
            after: 5,
            newSquares: [
              square("d7"),
              square("e6"),
              square("f5"),
              square("g4"),
              square("h3")
            ]
          }
        ]
      },
      castling: {
        lostRights: [],
        paths: [
          {
            side: "ai",
            wing: "queenside",
            rightBefore: true,
            rightAfter: true,
            blockersBefore: [square("b8"), square("c8"), square("d8")],
            blockersAfter: [square("b8"), square("d8")],
            clearedSquares: [square("c8")],
            pathClear: false,
            legalNow: false
          }
        ]
      }
    }
  }
}

test("context variants enable independent features and preserve baseline output exactly", () => {
  assert.deepEqual(
    CONTEXT_VARIANTS.map((variant) => variant.id),
    ["baseline", "relationships", "support", "mobility", "castling", "all"]
  )
  for (const variant of CONTEXT_VARIANTS.slice(1, -1))
    assert.equal(Object.values(variant.features).filter(Boolean).length, 1)
  const move = contextFixture()
  const baseline = formatMoveOutcome(move, "ai", 9, BASE_CONTEXT_FEATURES)
  assert.equal(formatMoveOutcome(move, "ai"), baseline)
  const withoutContext = {
    ...move,
    outcome: {
      ...move.outcome,
      relationships: undefined,
      support: undefined,
      mobility: undefined,
      castling: undefined
    }
  }
  assert.equal(baseline, formatMoveOutcome(withoutContext, "ai"))
})

test("relationship context preserves every moved-piece attacker and distinguishes hypothetical threats", () => {
  const text = formatMoveOutcome(contextFixture(), "ai", 9, {
    ...BASE_CONTEXT_FEATURES,
    relationships: true
  })
  assert.match(
    text,
    /moved piece capturable by white pawn1@e4, bishop3@g2, queen9@d1/
  )
  const move = contextFixture()
  const relationship = move.outcome.relationships
  assert.ok(relationship)
  relationship.movedPieceThreatenedBy = []
  relationship.movedPieceWasThreatened = false
  const threats = formatMoveOutcome(move, "ai", 9, {
    ...BASE_CONTEXT_FEATURES,
    relationships: true
  })
  assert.match(
    threats,
    /new threat on unchanged board: white queen9@d1 by bishop3@g4/
  )
  assert.match(threats, /ends capture threat to own rook5@a8/)
  assert.doesNotMatch(
    text,
    /conditional support|pawn advances|castling path update/
  )
})

test("support states an actual conditional recapture without claiming immunity", () => {
  const move = contextFixture()
  const features = { ...BASE_CONTEXT_FEATURES, support: true }
  const text = formatMoveOutcome(move, "ai", 9, features)
  assert.match(text, /after e4d5: own queen9@d8 can recapture/)
  assert.match(text, /legal recapturers:/)
  assert.doesNotMatch(text, /immune|cannot be captured|safe move/)
  const support = move.outcome.support
  assert.ok(support)
  support.conditionalRecaptures = []
  assert.match(
    formatMoveOutcome(move, "ai", 9, features),
    /geometric support \(not legal recapture\): queen9@d8/
  )
})

test("mobility describes one- and two-square pawn advances neutrally and names opened destinations", () => {
  const move = contextFixture()
  const features = { ...BASE_CONTEXT_FEATURES, mobility: true }
  const text = formatMoveOutcome(move, "ai", 9, features)
  assert.match(text, /pawn advances 2 squares, controls e4/)
  assert.match(text, /own bishop3@c8 legal destinations 0->5, adds d7, e6 \+3/)
  assert.doesNotMatch(text, /good|bad|best|score|castling path update/)
  const pawnAdvance = move.outcome.mobility?.pawnAdvance
  assert.ok(pawnAdvance)
  pawnAdvance.squares = 1
  assert.match(
    formatMoveOutcome(move, "ai", 9, features),
    /pawn advances 1 square,/
  )
})

test("castling distinguishes remaining blockers from clear but unavailable and ready paths", () => {
  const move = contextFixture()
  const features = { ...BASE_CONTEXT_FEATURES, castling: true }
  assert.match(
    formatMoveOutcome(move, "ai", 9, features),
    /black queenside clears c8, still blocked by b8, d8/
  )
  const castling = move.outcome.castling
  assert.ok(castling)
  const path = castling.paths[0]
  path.blockersAfter = []
  path.pathClear = true
  assert.match(
    formatMoveOutcome(move, "ai", 9, features),
    /path clear, not currently legal/
  )
  path.legalNow = true
  assert.match(
    formatMoveOutcome(move, "ai", 9, features),
    /path clear, legal on unchanged board/
  )
  castling.lostRights = [{ side: "ai", wing: "kingside" }]
  assert.match(
    formatMoveOutcome(move, "ai", 9, features),
    /permanently loses held castling rights: black kingside/
  )
})

test("all context keeps critical outcomes and adds at most three compact facts", () => {
  const move = contextFixture()
  move.outcome.allowsMateInOne = true
  const baseline = formatMoveOutcome(move, "ai")
  const all = CONTEXT_VARIANTS.find((variant) => variant.id === "all")
  assert.ok(all)
  const text = formatMoveOutcome(move, "ai", 9, all.features)
  assert.ok(text.startsWith(baseline))
  assert.match(text, /DANGER: opponent can CHECKMATE next turn/)
  assert.ok(text.split("; ").length - baseline.split("; ").length <= 3)
  assert.ok(text.length - baseline.length <= 100)
  assert.match(text, /moved piece capturable by/)
})

test("terminal candidates omit all optional future context while preserving exact core outcomes", () => {
  const all = CONTEXT_VARIANTS.find((variant) => variant.id === "all")
  assert.ok(all)
  const terminals = [
    { checkmate: true, stalemate: false },
    { checkmate: false, stalemate: true, drawReason: "Stalemate" },
    { checkmate: false, stalemate: false, drawReason: "Threefold repetition" }
  ]
  for (const terminal of terminals) {
    const move = contextFixture()
    Object.assign(move.outcome, terminal)
    const baseline = formatMoveOutcome(move, "ai")
    assert.equal(formatMoveOutcome(move, "ai", 9, all.features), baseline)
    assert.doesNotMatch(
      baseline,
      /moved piece capturable|can recapture|geometric support|pawn advances|queenside clears/
    )
  }
})

test("an actual mating move keeps capture facts and drops post-game castling context", () => {
  const all = CONTEXT_VARIANTS.find((variant) => variant.id === "all")
  assert.ok(all)
  const game = fromFen("3q2k1/4bppp/8/8/8/8/5PPP/3R2K1 b - - 0 1")
  const move = annotatedLegalMoves(game, all.features).find(
    (entry) => entry.id === "d8d1"
  )
  assert.ok(move)
  assert.equal(move.outcome.checkmate, true)
  const baseline = formatMoveOutcome(move, "ai")
  assert.match(
    baseline,
    /captures white rook \(5\); CHECKMATE, wins immediately/
  )
  assert.equal(formatMoveOutcome(move, "ai", 9, all.features), baseline)
  const foolsMate = ["f2f3", "e7e5", "g2g4"].reduce(applyMove, newGame("white"))
  const queen = annotatedLegalMoves(foolsMate, all.features).find(
    (entry) => entry.id === "d8h4"
  )
  assert.ok(queen)
  assert.ok(
    queen.outcome.castling?.paths.some((path) => path.clearedSquares.length > 0)
  )
  assert.equal(
    formatMoveOutcome(queen, "ai", 9, all.features),
    "d8h4: queen d8-h4; outcome: CHECKMATE, wins immediately"
  )
})
