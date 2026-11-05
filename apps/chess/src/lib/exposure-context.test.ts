import assert from "node:assert/strict"
import { test } from "node:test"
import { Chess } from "chess.js"
import type { Move as ChessMove } from "chess.js"
import {
  annotatedLegalMoves,
  applyMove,
  currentThreats,
  fromFen,
  newGame
} from "./chess.ts"
import { buildSharedPrompt } from "./shared-prompt.ts"
import { resolveActionLabel } from "./move-choice.ts"

const fixtures = [
  {
    id: "bishop-ray-rook",
    fen: "6k1/8/4r3/3n4/8/1B6/2P5/2K5 b - - 0 40",
    move: "d5b6",
    rejected: true
  },
  {
    id: "rook-ray-queen",
    fen: "3q2k1/8/3n4/8/8/8/8/3R3K b - - 0 40",
    move: "d6f5",
    rejected: true
  },
  {
    id: "defender-withdrawal",
    fen: "6k1/3b4/4r3/8/8/8/8/3KR3 b - - 0 40",
    move: "d7b5",
    rejected: true
  },
  {
    id: "unsupported-unattacked",
    fen: "6k1/8/4r3/3n4/8/8/8/3R3K b - - 0 40",
    move: "d5b6",
    rejected: false
  },
  {
    id: "pinned-capture",
    fen: "1r4k1/8/4r3/3n4/8/1B6/8/1K6 b - - 0 40",
    move: "d5f4",
    rejected: false
  },
  {
    id: "check-forces-response",
    fen: "3q2k1/8/3n3K/8/8/8/8/3R4 b - - 0 40",
    move: "d6f5",
    rejected: false
  },
  {
    id: "compensating-capture",
    fen: "6k1/8/1Q2r3/3n4/8/1B6/2P5/2K5 b - - 0 40",
    move: "d5b6",
    rejected: false
  }
] as const
const index = (square: string) =>
  (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97
const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
const balance = (fen: string) =>
  new Chess(fen)
    .board()
    .flat()
    .reduce(
      (sum, piece) =>
        sum + (piece ? (piece.color === "b" ? 1 : -1) * values[piece.type] : 0),
      0
    )
const idOf = (move: ChessMove) =>
  `${move.from}${move.to}${move.promotion ?? ""}`
const captureSquare = (move: ChessMove) =>
  move.isEnPassant()
    ? `${move.to[0]}${Number(move.to[1]) + (move.color === "w" ? -1 : 1)}`
    : move.to
const atWhiteTurn = (fen: string) => {
  const fields = fen.split(" ")
  fields[1] = "w"
  fields[3] = "-"
  return new Chess(fields.join(" "))
}
const fixture = (id: (typeof fixtures)[number]["id"]) => {
  const row = fixtures.find((fixture) => fixture.id === id)
  assert.ok(row, `Expected fixture ${id}`)
  return row
}
const candidate = (id: (typeof fixtures)[number]["id"]) => {
  const row = fixture(id)
  const move = annotatedLegalMoves(fromFen(row.fen), {
    relationships: true,
    support: true,
    safety: true
  }).find((move) => move.id === row.move)
  assert.ok(move)
  return move
}

/** Independent leaf-board material counts, not the production formula/annotations. */
function acceptedByImmediateSafety(fen: string, allPieces = false): string[] {
  const before = balance(fen)
  return new Chess(fen)
    .moves({ verbose: true })
    .filter((move) => {
      const next = new Chess(move.after)
      if (next.isGameOver()) return true
      return next.moves({ verbose: true }).every((reply) => {
        const leaf = new Chess(reply.after)
        if (leaf.isCheckmate()) return false
        if (
          !reply.captured ||
          reply.captured === "k" ||
          (!allPieces && reply.captured !== "q" && reply.captured !== "r")
        )
          return true
        const recaptures = leaf.isGameOver()
          ? []
          : leaf
              .moves({ verbose: true })
              .filter(
                (recapture) =>
                  recapture.captured && captureSquare(recapture) === reply.to
              )
        const bestLeaf = Math.max(
          balance(reply.after),
          ...recaptures.map((recapture) => balance(recapture.after))
        )
        return bestLeaf >= before
      })
    })
    .map(idOf)
}

test("a safe quiet knight retreat exposes another rook without any new compensating attack", () => {
  const row = fixture("bishop-ray-rook"),
    move = candidate(row.id)
  assert.equal(move.captured, undefined)
  assert.equal(move.promotion, undefined)
  assert.equal(move.outcome.check, false)
  assert.equal(move.outcome.recapture.count, 0)
  assert.deepEqual(move.outcome.relationships?.newThreats, [])
  assert.ok(
    !atWhiteTurn(row.fen)
      .moves({ verbose: true })
      .some((reply) => reply.captured === "r")
  )
  assert.deepEqual(move.outcome.replyMajorLosses, [
    {
      piece: "r",
      square: index("e6"),
      capturedBy: { piece: "b", square: index("b3") },
      netMaterial: -5
    }
  ])
  const engine = new Chess(row.fen)
  engine.move({ from: "d5", to: "b6" })
  engine.move({ from: "b3", to: "e6" })
  assert.equal(balance(engine.fen()) - balance(row.fen), -5)
})

test("a reciprocal future queen attack does not cancel the rook's next-turn queen capture", () => {
  const move = candidate("rook-ray-queen")
  assert.equal(move.outcome.recapture.count, 0)
  assert.equal(move.outcome.check, false)
  assert.equal(move.captured, undefined)
  assert.deepEqual(move.outcome.replyMajorLosses, [
    {
      piece: "q",
      square: index("d8"),
      capturedBy: { piece: "r", square: index("d1") },
      netMaterial: -9
    }
  ])
  assert.ok(
    move.outcome.relationships?.newThreats.some(
      (threat) =>
        threat.target.square === index("d1") &&
        threat.attackers.some((piece) => piece.piece === "q")
    )
  )
})

test("withdrawing a defender turns an existing equal rook exchange into an uncompensated rook loss", () => {
  const row = fixture("defender-withdrawal"),
    before = atWhiteTurn(row.fen)
  const score = balance(row.fen)
  before.move({ from: "e1", to: "e6" })
  before.move({ from: "d7", to: "e6" })
  assert.equal(balance(before.fen()), score)
  const move = candidate(row.id)
  assert.equal(move.outcome.recapture.count, 0)
  assert.deepEqual(move.outcome.relationships?.newThreats, [])
  assert.equal(move.outcome.replyMajorLosses?.[0]?.netMaterial, -5)
  const after = new Chess(row.fen)
  after.move({ from: "d7", to: "b5" })
  after.move({ from: "e1", to: "e6" })
  assert.ok(
    !after
      .moves({ verbose: true })
      .some((reply) => reply.captured && captureSquare(reply) === "e6")
  )
})

test("an undefended rook without any legal enemy capture is not labeled a material loss", () => {
  const row = fixture("unsupported-unattacked"),
    engine = new Chess(row.fen)
  engine.move({ from: "d5", to: "b6" })
  assert.deepEqual(engine.attackers("e6", "b"), [])
  assert.ok(
    !engine.moves({ verbose: true }).some((reply) => reply.captured === "r")
  )
  assert.deepEqual(candidate(row.id).outcome.replyMajorLosses, [])
})

test("an opened geometric bishop ray is harmless when its capture is illegal because of a pin", () => {
  const row = fixture("pinned-capture"),
    engine = new Chess(row.fen)
  engine.move({ from: "d5", to: "f4" })
  assert.ok(engine.attackers("e6", "w").includes("b3"))
  assert.ok(
    !engine
      .moves({ verbose: true })
      .some((reply) => reply.from === "b3" && reply.to === "e6")
  )
  assert.deepEqual(candidate(row.id).outcome.replyMajorLosses, [])
})

test("a forcing check prevents an otherwise geometric capture of the exposed queen", () => {
  const row = fixture("check-forces-response"),
    move = candidate(row.id),
    engine = new Chess(row.fen)
  engine.move({ from: "d6", to: "f5" })
  assert.equal(engine.isCheck(), true)
  assert.ok(engine.attackers("d8", "w").includes("d1"))
  assert.ok(
    !engine
      .moves({ verbose: true })
      .some((reply) => reply.from === "d1" && reply.to === "d8")
  )
  assert.equal(move.outcome.check, true)
  assert.deepEqual(move.outcome.replyMajorLosses, [])
})

test("capturing a queen compensates for the other rook being captured next", () => {
  const row = fixture("compensating-capture"),
    move = candidate(row.id),
    engine = new Chess(row.fen)
  engine.move({ from: "d5", to: "b6" })
  engine.move({ from: "b3", to: "e6" })
  assert.equal(balance(engine.fen()) - balance(row.fen), 4)
  assert.equal(move.captured, "q")
  assert.deepEqual(move.outcome.replyMajorLosses, [])
})

test("broad independent accepted sets match existing major-loss facts without choosing a favorite", () => {
  for (const row of fixtures) {
    const game = fromFen(row.fen),
      before = JSON.stringify(game)
    const independent = acceptedByImmediateSafety(row.fen)
    const analyzed = annotatedLegalMoves(game, { safety: true })
    const factual = analyzed
      .filter(
        (move) =>
          !move.outcome.allowsMateInOne &&
          move.outcome.replyMajorLosses?.length === 0
      )
      .map((move) => move.id)
    assert.deepEqual(new Set(factual), new Set(independent), row.id)
    assert.equal(independent.includes(row.move), !row.rejected, row.id)
    assert.ok(independent.length > 1, `${row.id}: should accept alternatives`)
    assert.equal(JSON.stringify(game), before)
  }
})

test("all-piece material facts are opt-in and retain a filtered major-piece compatibility view", () => {
  const game = fromFen("6k1/8/5n2/8/4P3/3P4/8/7K b - - 0 40")
  assert.ok(
    annotatedLegalMoves(game).every(
      (move) => move.outcome.replyMaterialLosses === undefined
    )
  )
  for (const move of annotatedLegalMoves(game, { safety: true })) {
    assert.deepEqual(
      move.outcome.replyMajorLosses,
      move.outcome.replyMaterialLosses?.filter(
        (loss) => loss.piece === "q" || loss.piece === "r"
      )
    )
  }
})

test("a knight taking a defended pawn can lose two material immediately", () => {
  const game = fromFen("6k1/8/5n2/8/4P3/3P4/8/7K b - - 0 40")
  const move = annotatedLegalMoves(game, { safety: true }).find(
    (move) => move.id === "f6e4"
  )
  assert.ok(move, "Expected the fixture move to be legal")
  assert.equal(move.captured, "p")
  assert.deepEqual(move.outcome.replyMaterialLosses, [
    {
      piece: "n",
      square: index("e4"),
      capturedBy: { piece: "p", square: index("d3") },
      netMaterial: -2
    }
  ])
  assert.deepEqual(move.outcome.replyMajorLosses, [])
})

test("a friendly pawn recapture still leaves the knight-for-pawn exchange down one", () => {
  const fen = "6k1/8/5n2/5p2/4P3/3P4/8/7K b - - 0 40"
  const move = annotatedLegalMoves(fromFen(fen), {
    safety: true,
    support: true
  }).find((move) => move.id === "f6e4")
  assert.ok(move, "Expected the fixture move to be legal")
  assert.equal(move.outcome.replyMaterialLosses?.[0]?.netMaterial, -1)
  assert.ok(
    move.outcome.support?.movedPieceGeometricDefenders.some(
      (piece) => piece.square === index("f5")
    )
  )
  const engine = new Chess(fen)
  engine.move({ from: "f6", to: "e4" })
  engine.move({ from: "d3", to: "e4" })
  engine.move({ from: "f5", to: "e4" })
  assert.equal(balance(engine.fen()) - balance(fen), -1)
})

test("retaking the opposing queen compensates the knight capture with net plus seven", () => {
  const fen = "6k1/8/5n2/5p2/4P3/3Q4/8/7K b - - 0 40"
  const move = annotatedLegalMoves(fromFen(fen), { safety: true }).find(
    (move) => move.id === "f6e4"
  )
  assert.ok(move, "Expected the fixture move to be legal")
  assert.equal(move.outcome.recapture.count, 1)
  assert.deepEqual(move.outcome.replyMaterialLosses, [])
  const engine = new Chess(fen)
  engine.move({ from: "f6", to: "e4" })
  engine.move({ from: "d3", to: "e4" })
  engine.move({ from: "f5", to: "e4" })
  assert.equal(balance(engine.fen()) - balance(fen), 7)
})

test("only actual legal king or pawn captures count after the board changes", () => {
  const pinned = annotatedLegalMoves(
    fromFen("3r2k1/8/5n2/8/4P3/3P4/8/3K4 b - - 0 40"),
    { safety: true }
  ).find((move) => move.id === "f6e4")
  assert.ok(pinned, "Expected the fixture move to be legal")
  assert.deepEqual(pinned.outcome.replyMaterialLosses, [])
  const kingDefends = annotatedLegalMoves(
    fromFen("6k1/8/5n2/8/4P3/3K4/P7/8 b - - 0 40"),
    { safety: true }
  ).find((move) => move.id === "f6e4")
  assert.ok(kingDefends, "Expected the fixture move to be legal")
  assert.ok(
    kingDefends.outcome.replyMaterialLosses?.some(
      (loss) => loss.capturedBy.piece === "k" && loss.netMaterial === -2
    )
  )
  const kingCannotCapture = annotatedLegalMoves(
    fromFen("6k1/8/5n2/5p2/4P3/3K4/P7/8 b - - 0 40"),
    { safety: true }
  ).find((move) => move.id === "f6e4")
  assert.ok(kingCannotCapture, "Expected the fixture move to be legal")
  assert.deepEqual(kingCannotCapture.outcome.replyMaterialLosses, [])
})

test("pawn exposure requires an actual capture and en passant reports the removed pawn square", () => {
  const safe = annotatedLegalMoves(fromFen("6k1/4p3/8/8/8/8/8/7K b - - 0 40"), {
    safety: true
  }).find((move) => move.id === "e7e5")
  assert.ok(safe, "Expected the fixture move to be legal")
  assert.deepEqual(safe.outcome.replyMaterialLosses, [])
  const ep = annotatedLegalMoves(fromFen("7k/3p4/8/4P3/8/8/8/7K b - - 0 40"), {
    safety: true
  }).find((move) => move.id === "d7d5")
  assert.ok(ep, "Expected the fixture move to be legal")
  assert.deepEqual(ep.outcome.replyMaterialLosses, [
    {
      piece: "p",
      square: index("d5"),
      capturedBy: { piece: "p", square: index("e5") },
      netMaterial: -1
    }
  ])
})

const observedHistory = [
  "e2e4",
  "e7e6",
  "d2d3",
  "e6e5",
  "g1f3",
  "b8a6",
  "f3e5",
  "d7d6",
  "e5c4",
  "e8d7",
  "d1g4",
  "d7c6",
  "c4a5",
  "c6b5",
  "c2c4",
  "b5a5",
  "a2a4",
  "a6b4",
  "c1d2",
  "c7c5",
  "g4g5",
  "d8c7",
  "d2b4",
  "a5b6",
  "a4a5",
  "b6a6",
  "b4a3",
  "c7b6",
  "b1c3",
  "b6c7",
  "c3d5",
  "c7b8",
  "g5d8",
  "g7g5",
  "d8f8",
  "c8d7",
  "f8d6",
  "b8d6",
  "b2b4",
  "d6d5",
  "e4d5",
  "d7e8",
  "b4b5",
  "a6a5",
  "a3b2",
  "a5b6",
  "d3d4",
  "c5d4",
  "a1c1",
  "g8e7",
  "b2d4",
  "b6c7",
  "d4h8",
  "e7g6",
  "f1d3",
  "g6f4",
  "d3h7"
]

test("the observed quiet Ne2 rook threat does not compensate White's legal king capture", () => {
  const game = observedHistory.reduce(applyMove, newGame("white"))
  assert.equal(
    game.fen,
    "r3b2B/ppk2p1B/8/1P1P2p1/2P2n2/8/5PPP/2R1K2R b K - 0 29"
  )
  const before = JSON.stringify(game)
  const move = annotatedLegalMoves(game, {
    safety: true,
    relationships: true
  }).find((move) => move.id === "f4e2")
  assert.ok(move, "Expected the fixture move to be legal")
  assert.equal(move.captured, undefined)
  assert.equal(move.outcome.check, false)
  assert.ok(
    move.outcome.relationships?.newThreats.some(
      (threat) =>
        threat.target.piece === "r" && threat.target.square === index("c1")
    )
  )
  assert.deepEqual(move.outcome.replyMaterialLosses, [
    {
      piece: "n",
      square: index("e2"),
      capturedBy: { piece: "k", square: index("e1") },
      netMaterial: -3
    }
  ])
  assert.deepEqual(move.outcome.replyMajorLosses, [])
  const engine = new Chess(game.fen)
  engine.move({ from: "f4", to: "e2" })
  engine.move({ from: "e1", to: "e2" })
  assert.equal(balance(engine.fen()) - balance(game.fen), -3)
  assert.equal(JSON.stringify(game), before)
})

test("all-capture safety matches fresh leaf-board material counts without filtering the legal list", () => {
  for (const fen of [
    "6k1/8/5n2/8/4P3/3P4/8/7K b - - 0 40",
    "6k1/8/5n2/5p2/4P3/3P4/8/7K b - - 0 40",
    "6k1/8/5n2/5p2/4P3/3Q4/8/7K b - - 0 40",
    "r3b2B/ppk2p1B/8/1P1P2p1/2P2n2/8/5PPP/2R1K2R b K - 0 29"
  ]) {
    const annotated = annotatedLegalMoves(fromFen(fen), { safety: true })
    const expected = acceptedByImmediateSafety(fen, true)
    const actual = annotated
      .filter(
        (move) =>
          !move.outcome.allowsMateInOne &&
          move.outcome.replyMaterialLosses?.length === 0
      )
      .map((move) => move.id)
    assert.deepEqual(new Set(actual), new Set(expected))
    assert.deepEqual(
      annotated.map((move) => move.id),
      new Chess(fen).moves({ verbose: true }).map(idOf)
    )
  }
})

test("the normal game that exceeded the former character guard preserves its board, history and every legal card", () => {
  const sanHistory = [
    "e4",
    "d5",
    "exd5",
    "Qd7",
    "Bb5",
    "Qxb5",
    "Qe2",
    "Qxd5",
    "Qf3",
    "Qc5",
    "Nc3",
    "Qe5+",
    "Nge2",
    "a5",
    "Ne4",
    "b6",
    "d4"
  ]
  const independent = new Chess()
  const uciHistory = sanHistory.map((san) => idOf(independent.move(san)))
  const game = uciHistory.reduce(applyMove, newGame("white"))
  assert.equal(
    game.fen,
    "rnb1kbnr/2p1pppp/1p6/p3q3/3PN3/5Q2/PPP1NPPP/R1B1K2R b KQkq - 0 9"
  )
  assert.equal(game.fen, independent.fen())
  assert.equal(game.turn, "ai")
  assert.equal(game.history.length, 17)
  assert.deepEqual(
    game.history.map((move) => move.notation),
    sanHistory
  )
  const before = JSON.stringify(game)
  // Match production analysis options. Size is a diagnostic, never a character budget.
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    safety: true
  })
  const threats = currentThreats(game)
  const { prompt, choices } = buildSharedPrompt({
    game,
    moves,
    currentThreats: threats
  })
  const legalIds = independent.moves({ verbose: true }).map(idOf)
  assert.equal(legalIds.length, 41)
  assert.deepEqual(
    choices.map((choice) => choice.id),
    legalIds
  )
  assert.deepEqual(
    prompt
      .split("\n")
      .filter((line) =>
        choices.some(choice => line.startsWith(choice.label + " | "))
      )
      .map((line) => resolveActionLabel(moves, line.split(" | ")[0])),
    legalIds
  )
  assert.deepEqual(
    choices.map((choice) => choice.notation),
    independent.moves({ verbose: true }).map((move) => move.san)
  )
  assert.ok(prompt.includes("Queens: e5"))
  assert.ok(prompt.includes("Queens: f3"))
  assert.ok(
    threats.some(
      (threat) =>
        threat.target.piece === "q" &&
        threat.target.square === index("e5") &&
        threat.attackers.some(
          (piece) => piece.piece === "p" && piece.square === index("d4")
        )
    )
  )
  const recent = game.history
    .slice(-8)
    .map(
      (move) =>
        `${move.side === "human" ? "Opponent" : "You"}: ${move.notation} (${move.id})`
    )
  assert.ok(prompt.includes(recent.join("\n")))
  assert.equal(JSON.stringify(game), before)
})

const observedBishopOpportunitySan = [
  "e4",
  "d5",
  "exd5",
  "Qd7",
  "Bb5",
  "Qxb5",
  "Qe2",
  "Qxd5",
  "Qf3",
  "Qc5",
  "Nc3",
  "Qe5+",
  "Nge2",
  "a5",
  "Ne4",
  "b6",
  "d4",
  "Qe6",
  "Ng5",
  "Qd7",
  "Nxf7",
  "Qxd4",
  "Nxh8",
  "Qb4+",
  "c3",
  "Qh4",
  "g3",
  "Qa4",
  "b3",
  "Qb5",
  "Bf4",
  "c6",
  "Bxb8"
]

test("the first observed missed bishop is a clean capture before the quiet pawn push", () => {
  const replay = new Chess()
  const ids = observedBishopOpportunitySan.map((san) => idOf(replay.move(san)))
  const game = ids.reduce(applyMove, newGame("white"))
  assert.equal(
    game.fen,
    "rBb1kbnN/4p1pp/1pp5/pq6/8/1PP2QP1/P3NP1P/R3K2R b KQq - 0 17"
  )
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    safety: true
  })
  const capture = moves.find((move) => move.id === "a8b8"),
    quiet = moves.find((move) => move.id === "a5a4")
  assert.ok(capture)
  assert.ok(quiet)
  assert.equal(capture.captured, "b")
  assert.equal(capture.outcome.recapture.count, 0)
  assert.equal(capture.outcome.allowsMateInOne, false)
  assert.deepEqual(capture.outcome.replyMaterialLosses, [])
  assert.equal(quiet.captured, undefined)
  assert.deepEqual(quiet.outcome.replyMaterialLosses, [])
  const before = balance(replay.fen())
  replay.move({ from: "a8", to: "b8" })
  assert.equal(balance(replay.fen()) - before, 3)
  const card = buildSharedPrompt({
    game,
    moves,
    currentThreats: currentThreats(game)
  }).choices.find((choice) => choice.id === capture.id)
  assert.ok(card?.outcome.includes("CAPTURES bishop"))
})

test("two plies later capturing the bishop would leave the queen lost, so Qxa4 is a valid rescue", () => {
  const replay = new Chess()
  const ids = [...observedBishopOpportunitySan, "a4", "bxa4"].map((san) =>
    idOf(replay.move(san))
  )
  const game = ids.reduce(applyMove, newGame("white"))
  assert.equal(
    game.fen,
    "rBb1kbnN/4p1pp/1pp5/1q6/P7/2P2QP1/P3NP1P/R3K2R b KQq - 0 18"
  )
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    safety: true
  })
  const bishopCapture = moves.find((move) => move.id === "a8b8"),
    queenRescue = moves.find((move) => move.id === "b5a4")
  assert.ok(bishopCapture)
  assert.ok(queenRescue)
  assert.equal(bishopCapture.captured, "b")
  assert.equal(bishopCapture.outcome.recapture.count, 0)
  assert.ok(
    bishopCapture.outcome.replyMaterialLosses?.some(
      (loss) =>
        loss.piece === "q" &&
        loss.square === index("b5") &&
        loss.netMaterial === -5
    )
  )
  assert.equal(queenRescue.captured, "p")
  assert.deepEqual(queenRescue.outcome.replyMaterialLosses, [])
  assert.ok(
    queenRescue.outcome.relationships?.resolvedThreats.some(
      (piece) => piece.piece === "q"
    )
  )
  const before = balance(replay.fen())
  replay.move({ from: "a8", to: "b8" })
  replay.move({ from: "a4", to: "b5" })
  replay.move({ from: "c6", to: "b5" })
  assert.equal(balance(replay.fen()) - before, -5)
})

test("the latest observed Nxf5 permits both a direct recapture and a safe forcing gain", () => {
  const san = [
    ...observedBishopOpportunitySan,
    "a4",
    "bxa4",
    "Qxa4",
    "Qf4",
    "Qc2",
    "Qf3",
    "Rxa2",
    "Rxa2",
    "Qb1+",
    "Kd2",
    "Qb5",
    "Qf5",
    "Bxf5",
    "Nd4",
    "Qc5",
    "Nxf5"
  ]
  const replay = new Chess()
  const history = san.map((notation) => idOf(replay.move(notation)))
  const game = history.reduce(applyMove, newGame("white"))
  assert.equal(game.history.length, 49)
  assert.equal(
    game.fen,
    "1B2kbnN/4p1pp/1pp5/2q2N2/8/2P3P1/R2K1P1P/7R b - - 0 25"
  )
  assert.equal(game.fen, replay.fen())
  assert.equal(game.history.at(-1)?.id, "d4f5")
  assert.equal(game.history.at(-1)?.captured, "b")
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    safety: true
  })
  const recapture = moves.find((move) => move.id === "c5f5"),
    pawnCapture = moves.find((move) => move.id === "c5f2"),
    quiet = moves.find((move) => move.id === "h7h5")
  assert.ok(recapture)
  assert.ok(pawnCapture)
  assert.ok(quiet)
  assert.equal(recapture.captured, "n")
  assert.equal(recapture.path[1], game.history.at(-1)?.path[1])
  assert.equal(recapture.outcome.recapture.count, 0)
  assert.equal(recapture.outcome.allowsMateInOne, false)
  assert.deepEqual(recapture.outcome.replyMaterialLosses, [])
  assert.equal(pawnCapture.captured, "p")
  assert.deepEqual(pawnCapture.outcome.replyMaterialLosses, [])
  assert.equal(quiet.captured, undefined)
  const before = balance(replay.fen())
  replay.move({ from: "c5", to: "f5" })
  assert.equal(balance(replay.fen()) - before, 3)
  assert.deepEqual(replay.get("f5"), { color: "b", type: "q" })
  const card = buildSharedPrompt({
    game,
    moves,
    currentThreats: currentThreats(game)
  }).choices.find((choice) => choice.id === "c5f5")
  assert.ok(card?.outcome.includes("CAPTURES knight"))
  const forcing = new Chess(game.fen)
  forcing.move({ from: "c5", to: "f2" })
  assert.equal(forcing.isCheck(), true)
  const evasions = forcing.moves({ verbose: true })
  assert.deepEqual(
    new Set(evasions.map((move) => move.san)),
    new Set(["Kd3", "Kd1", "Kc1"])
  )
  for (const evasion of evasions) {
    const continuation = new Chess(evasion.after)
    const followup = continuation
      .moves({ verbose: true })
      .find(
        (move) =>
          move.from === "f2" && move.to === "f5" && move.captured === "n"
      )
    assert.ok(followup)
    assert.equal(balance(followup.after) - before, 4)
    const facts = annotatedLegalMoves(fromFen(evasion.after), {
      safety: true
    }).find((move) => move.id === "f2f5")
    assert.ok(facts)
    assert.equal(facts.outcome.recapture.count, 0)
    assert.equal(facts.outcome.allowsMateInOne, false)
    assert.deepEqual(facts.outcome.replyMaterialLosses, [])
  }
})

const observedH7OpportunitySan = [
  "e4",
  "d5",
  "exd5",
  "Qd7",
  "Bb5",
  "Qxb5",
  "Qe2",
  "Qxd5",
  "Qf3",
  "Qc5",
  "Nc3",
  "Qe5+",
  "Nge2",
  "a5",
  "Ne4",
  "b6",
  "d4",
  "Qe6",
  "Ng5",
  "Qd7",
  "Nxf7",
  "Qxd4",
  "Nxh8",
  "Qb4+",
  "c3",
  "Qh4",
  "g3",
  "Qa4",
  "b3",
  "Qb5",
  "Bf4",
  "c6",
  "Bxb8",
  "a4",
  "bxa4",
  "Qxa4",
  "Qf4",
  "Qc2",
  "Qf3",
  "Rxa2",
  "Rxa2",
  "Qb1+",
  "Kd2",
  "Qb5",
  "Qf5",
  "Bxf5",
  "Nd4",
  "Qc5",
  "Nxf5",
  "h5",
  "Ra7",
  "Qd5+",
  "Kc2",
  "Qf3",
  "Bc7",
  "Qe4+",
  "Kb3",
  "Qxf5",
  "Ra8+",
  "Qc8",
  "Rxc8+",
  "Kd7",
  "Bxb6",
  "Kxc8",
  "Rd1",
  "Kb8",
  "Rd8+",
  "Kb7",
  "Bc5",
  "e5",
  "Kb4",
  "Bxc5+",
  "Kxc5",
  "Ne7",
  "Rd7+",
  "Kc8",
  "Rxe7",
  "g6",
  "Kxc6",
  "Kd8",
  "Rf7",
  "g5",
  "Ng6",
  "Ke8",
  "Rg7",
  "h4",
  "Kd6",
  "g4",
  "gxh4",
  "e4",
  "Ke6",
  "Kd8",
  "Rg8+",
  "Kc7",
  "Ne5",
  "Kb6",
  "Nc4+",
  "Kc5",
  "Na5",
  "e3",
  "fxe3",
  "Kb6",
  "Nc4+",
  "Kc5",
  "Nd2",
  "Kc6",
  "Ke5",
  "g3",
  "c4",
  "gxh2",
  "Rg6+",
  "Kc5",
  "Nf3",
  "h1=Q",
  "Nd2",
  "Qa1+",
  "Ke4",
  "Qe1",
  "Nb3+",
  "Kb4",
  "Nd4",
  "Ka4",
  "Ra6+",
  "Kb4",
  "Nc2+",
  "Kxc4",
  "Rc6+",
  "Kb3",
  "Rc5",
  "Qe2",
  "Nd4+",
  "Ka2",
  "Rb5",
  "Qd2",
  "Nb3",
  "Qd8",
  "h5",
  "Qf6",
  "Kd3",
  "Qf2",
  "h6",
  "Qh4",
  "h7"
]

test("the observed h7 pawn is a safe queen capture without pretending it is the only promotion defense", () => {
  const replay = new Chess()
  const history = observedH7OpportunitySan.map((notation) =>
    idOf(replay.move(notation))
  )
  const game = history.reduce(applyMove, newGame("white"))
  assert.equal(game.history.length, 143)
  assert.equal(game.fen, "8/7P/8/1R6/7q/1N1KP3/k7/8 b - - 0 72")
  assert.equal(game.fen, replay.fen())
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    safety: true
  })
  const capture = moves.find((move) => move.id === "h4h7")
  assert.ok(capture)
  assert.equal(capture.notation, "Qxh7+")
  assert.equal(capture.captured, "p")
  assert.equal(capture.outcome.recapture.count, 0)
  assert.equal(capture.outcome.allowsMateInOne, false)
  assert.deepEqual(capture.outcome.replyMaterialLosses, [])
  const before = balance(game.fen)
  replay.move({ from: "h4", to: "h7" })
  assert.equal(balance(replay.fen()) - before, 1)
  assert.ok(!replay.moves({ verbose: true }).some((move) => move.promotion))
  // The pawn blocks the file: Qh8 cannot jump over it.
  assert.ok(!moves.some((move) => move.id === "h4h8"))
  assert.throws(() => new Chess(game.fen).move({ from: "h4", to: "h8" }))
  for (const id of ["a2b1", "h4f6", "h4h1"]) {
    const defense = new Chess(game.fen)
    defense.move({ from: id.slice(0, 2), to: id.slice(2, 4) })
    const promotions = defense
      .moves({ verbose: true })
      .filter((move) => move.promotion)
    assert.equal(promotions.length, 4)
    for (const promotion of promotions) {
      const after = new Chess(promotion.after)
      assert.ok(
        after
          .moves({ verbose: true })
          .some(
            (move) => move.captured && captureSquare(move) === promotion.to
          ),
        `${id}: promoted piece can be captured`
      )
    }
  }
  const abandonedFile = new Chess(game.fen)
  abandonedFile.move({ from: "h4", to: "f2" })
  const promotions = abandonedFile
    .moves({ verbose: true })
    .filter((move) => move.promotion)
  assert.equal(promotions.length, 4)
  for (const promotion of promotions) {
    assert.ok(
      !new Chess(promotion.after)
        .moves({ verbose: true })
        .some((move) => move.captured && captureSquare(move) === promotion.to)
    )
  }
})

const observedPhoneQueenSan = [
  "e4",
  "Nh6",
  "d3",
  "g6",
  "Be2",
  "Na6",
  "Nh3",
  "Nb8",
  "O-O",
  "f6",
  "Bxh6",
  "Rg8",
  "Bxf8",
  "c5",
  "Ng5",
  "Kxf8",
  "Nxh7+",
  "Kf7",
  "d4",
  "d6",
  "dxc5",
  "d5",
  "exd5",
  "Ke8",
  "c6",
  "Rh8",
  "c7",
  "Qxc7",
  "d6",
  "Qb6",
  "dxe7",
  "Kf7",
  "Bh5",
  "Qb5",
  "f4"
]

test("the phone-game checking queen can legally be captured by the king or queen for net minus four", () => {
  const replay = new Chess()
  const history = observedPhoneQueenSan.map((san) => idOf(replay.move(san)))
  const game = history.reduce(applyMove, newGame("white"))
  assert.equal(history.length, 35)
  assert.equal(
    game.fen,
    "rnb4r/pp2Pk1N/5pp1/1q5B/5P2/8/PPP3PP/RN1Q1RK1 b - - 0 18"
  )
  const moves = annotatedLegalMoves(game, { safety: true })
  const sacrifice = moves.find((move) => move.id === "b5f1")
  assert.ok(sacrifice)
  assert.equal(sacrifice.notation, "Qxf1+")
  assert.equal(sacrifice.captured, "r")
  assert.equal(sacrifice.outcome.check, true)
  assert.equal(sacrifice.outcome.recapture.count, 2)
  assert.deepEqual(
    new Set(
      sacrifice.outcome.replyMaterialLosses?.map(
        (loss) => loss.capturedBy.piece
      )
    ),
    new Set(["q", "k"])
  )
  assert.ok(
    sacrifice.outcome.replyMaterialLosses?.every(
      (loss) => loss.netMaterial === -4
    )
  )
  for (const from of ["g1", "d1"]) {
    const line = new Chess(game.fen)
    line.move({ from: "b5", to: "f1" })
    line.move({ from, to: "f1" })
    assert.equal(balance(line.fen()) - balance(game.fen), -4)
  }
  // A defended queen exchange is not rejected just because a queen can be taken.
  const defended = moves.find((move) => move.id === "b5h5")
  assert.ok(defended)
  assert.equal(defended.outcome.recapture.count, 1)
  assert.deepEqual(defended.outcome.replyMaterialLosses, [])
  const line = new Chess(game.fen)
  line.move({ from: "b5", to: "h5" })
  line.move({ from: "d1", to: "h5" })
  line.move({ from: "g6", to: "h5" })
  assert.equal(balance(line.fen()) - balance(game.fen), 3)
})

test("the phone-game advanced pawn does not require sacrificing the queen", () => {
  const engine = new Chess()
  for (const san of observedPhoneQueenSan) engine.move(san)
  const capture = engine
    .moves({ verbose: true })
    .find(
      (move) => move.from === "f7" && move.to === "e7" && move.captured === "p"
    )
  assert.ok(capture)
  const whiteTurn = engine.fen().split(" ")
  whiteTurn[1] = "w"
  whiteTurn[3] = "-"
  const promotions = new Chess(whiteTurn.join(" "))
    .moves({ verbose: true })
    .filter((move) => move.promotion)
  assert.equal(promotions.length, 4)
  for (const promotion of promotions) {
    assert.ok(
      new Chess(promotion.after)
        .moves({ verbose: true })
        .some((move) => move.piece === "k" && move.to === "e8" && move.captured)
    )
  }
})

test("a checking queen protected by its king cannot be captured by the enemy king", () => {
  const fen = "8/8/8/8/5q2/8/4kP1P/6K1 b - - 0 40"
  const move = annotatedLegalMoves(fromFen(fen), { safety: true }).find(
    (move) => move.id === "f4f2"
  )
  assert.ok(move)
  assert.equal(move.outcome.check, true)
  assert.equal(move.outcome.recapture.count, 0)
  assert.deepEqual(move.outcome.replyMaterialLosses, [])
  const engine = new Chess(fen)
  engine.move({ from: "f4", to: "f2" })
  assert.ok(
    !engine
      .moves({ verbose: true })
      .some((reply) => reply.from === "g1" && reply.to === "f2")
  )
})

test("the five-ply thinking-on game has a free bishop capture rather than a quiet pawn push", () => {
  const replay = new Chess()
  const history = ["e4", "g6", "f3", "Nc6", "Ba6"].map((san) =>
    idOf(replay.move(san))
  )
  const game = history.reduce(applyMove, newGame("white"))
  assert.equal(
    game.fen,
    "r1bqkbnr/pppppp1p/B1n3p1/8/4P3/5P2/PPPP2PP/RNBQK1NR b KQkq - 2 3"
  )
  const moves = annotatedLegalMoves(game, { safety: true })
  const capture = moves.find((move) => move.id === "b7a6"),
    quiet = moves.find((move) => move.id === "d7d6")
  assert.ok(capture)
  assert.ok(quiet)
  assert.equal(capture.captured, "b")
  assert.equal(capture.outcome.recapture.count, 0)
  assert.equal(capture.outcome.allowsMateInOne, false)
  assert.deepEqual(capture.outcome.replyMaterialLosses, [])
  assert.equal(quiet.captured, undefined)
  assert.deepEqual(
    replay
      .moves({ verbose: true })
      .filter((move) => move.captured)
      .map(idOf),
    ["b7a6"]
  )
  assert.ok(
    !replay
      .moves({ verbose: true })
      .some((move) => new Chess(move.after).isCheck())
  )
  const before = balance(replay.fen())
  replay.move({ from: "b7", to: "a6" })
  assert.equal(balance(replay.fen()) - before, 3)
})

test("the h6 thinking-on incident permits three equally safe bishop captures", () => {
  const replay = new Chess()
  const history = ["e4", "e6", "d3", "h6", "Bxh6"].map((san) =>
    idOf(replay.move(san))
  )
  const game = history.reduce(applyMove, newGame("white"))
  assert.equal(
    game.fen,
    "rnbqkbnr/pppp1pp1/4p2B/8/4P3/3P4/PPP2PPP/RN1QKBNR b KQkq - 0 3"
  )
  const moves = annotatedLegalMoves(game, { safety: true })
  const captures = moves.filter((move) => move.captured)
  assert.deepEqual(
    new Set(captures.map((move) => move.id)),
    new Set(["g7h6", "g8h6", "h8h6"])
  )
  for (const capture of captures) {
    assert.equal(capture.captured, "b")
    assert.equal(capture.outcome.recapture.count, 0)
    assert.equal(capture.outcome.allowsMateInOne, false)
    assert.deepEqual(capture.outcome.replyMaterialLosses, [])
    const line = new Chess(game.fen)
    line.move({ from: capture.id.slice(0, 2), to: capture.id.slice(2, 4) })
    assert.equal(balance(line.fen()) - balance(game.fen), 3)
  }
  const quiet = moves.find((move) => move.id === "g7g6")
  assert.ok(quiet)
  assert.equal(quiet.captured, undefined)
})

test("Bb4 check does not force the escaped h6 bishop or an equivalent safe gain", () => {
  const replay = new Chess()
  for (const san of ["e4", "e6", "d3", "h6", "Bxh6"]) replay.move(san)
  const before = balance(replay.fen())
  assert.deepEqual(
    replay
      .moves({ verbose: true })
      .filter((move) => new Chess(move.after).isCheck())
      .map(idOf),
    ["f8b4"]
  )
  replay.move("Bb4+")
  assert.ok(replay.moves().includes("Bd2"))
  replay.move("Bd2")
  const captures = replay
    .moves({ verbose: true })
    .filter((move) => move.captured)
  assert.deepEqual(new Set(captures.map(idOf)), new Set(["b4d2", "h8h2"]))
  const bishopTrade = new Chess(replay.fen())
  bishopTrade.move("Bxd2+")
  const retakes = bishopTrade
    .moves({ verbose: true })
    .filter((move) => move.captured && move.to === "d2")
  assert.deepEqual(
    new Set(retakes.map((move) => move.piece)),
    new Set(["k", "n", "q"])
  )
  for (const retake of retakes) assert.equal(balance(retake.after) - before, 0)
  const rookDrop = new Chess(replay.fen())
  rookDrop.move("Rxh2")
  rookDrop.move("Rxh2")
  assert.equal(balance(rookDrop.fen()) - before, -4)
})
