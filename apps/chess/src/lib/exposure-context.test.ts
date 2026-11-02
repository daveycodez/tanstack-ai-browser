import assert from "node:assert/strict"
import { test } from "node:test"
import { Chess } from "chess.js"
import type { Move as ChessMove } from "chess.js"
import { annotatedLegalMoves, applyMove, fromFen, newGame } from "./chess.ts"

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
const fixture = (id: (typeof fixtures)[number]["id"]) =>
  fixtures.find((fixture) => fixture.id === id)!
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
  )!
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
  }).find((move) => move.id === "f6e4")!
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
  )!
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
  ).find((move) => move.id === "f6e4")!
  assert.deepEqual(pinned.outcome.replyMaterialLosses, [])
  const kingDefends = annotatedLegalMoves(
    fromFen("6k1/8/5n2/8/4P3/3K4/P7/8 b - - 0 40"),
    { safety: true }
  ).find((move) => move.id === "f6e4")!
  assert.ok(
    kingDefends.outcome.replyMaterialLosses?.some(
      (loss) => loss.capturedBy.piece === "k" && loss.netMaterial === -2
    )
  )
  const kingCannotCapture = annotatedLegalMoves(
    fromFen("6k1/8/5n2/5p2/4P3/3K4/P7/8 b - - 0 40"),
    { safety: true }
  ).find((move) => move.id === "f6e4")!
  assert.deepEqual(kingCannotCapture.outcome.replyMaterialLosses, [])
})

test("pawn exposure requires an actual capture and en passant reports the removed pawn square", () => {
  const safe = annotatedLegalMoves(fromFen("6k1/4p3/8/8/8/8/8/7K b - - 0 40"), {
    safety: true
  }).find((move) => move.id === "e7e5")!
  assert.deepEqual(safe.outcome.replyMaterialLosses, [])
  const ep = annotatedLegalMoves(fromFen("7k/3p4/8/4P3/8/8/8/7K b - - 0 40"), {
    safety: true
  }).find((move) => move.id === "d7d5")!
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
  const game = observedHistory.reduce(applyMove, newGame())
  assert.equal(
    game.fen,
    "r3b2B/ppk2p1B/8/1P1P2p1/2P2n2/8/5PPP/2R1K2R b K - 0 29"
  )
  const before = JSON.stringify(game)
  const move = annotatedLegalMoves(game, {
    safety: true,
    relationships: true
  }).find((move) => move.id === "f4e2")!
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
