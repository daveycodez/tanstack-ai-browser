import assert from "node:assert/strict"
import test from "node:test"
import { Chess } from "chess.js"
import { RECORDED_CASES } from "../../bench/recorded-cases.ts"
import {
  annotatedLegalMoves,
  applyMove,
  currentThreats,
  fromFen,
  newGame
} from "./chess.ts"
import { buildMoveAnalysis } from "./move-analysis.ts"
import {
  buildSharedPrompt,
  COMPACT_PROMPT_VERSION,
  CONCISE_PROMPT_VERSION,
  SHARED_PROMPT_VERSION,
  TACTICAL_PROMPT_VERSION,
  systemPromptFor
} from "./shared-prompt.ts"
const f = RECORDED_CASES.find((f) => f.id === "quiet-fork-king-rook")
assert.ok(f?.history)
const history = f.history
const actual = () => history.reduce(applyMove, newGame(f.humanColor))
const material = (b: Chess) =>
  b
    .board()
    .flat()
    .reduce(
      (n, p) =>
        n +
        (p
          ? { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }[p.type] *
            (p.color === "w" ? 1 : -1)
          : 0),
      0
    )

test("tactical guidance exposes the real fork and post-recapture loss with every legal action retained", () => {
  assert.equal(SHARED_PROMPT_VERSION, COMPACT_PROMPT_VERSION)
  const game = actual(),
    saved = structuredClone(game),
    old = buildMoveAnalysis({
      game,
      promptVersion: CONCISE_PROMPT_VERSION,
      moveOrder: f.orders[0]
    })
  const output = buildMoveAnalysis({
    game,
    promptVersion: TACTICAL_PROMPT_VERSION,
    moveOrder: f.orders[0]
  })
  assert.deepEqual(
    output.choices.map((c) => [c.id, c.notation]),
    old.choices.map((c) => [c.id, c.notation])
  )
  assert.equal(old.choices.find((c) => c.id === "c4b3")?.label, "Bb3")
  assert.equal(
    output.choices.find((c) => c.id === "c4b3")?.label,
    "RISK -1: Bb3"
  )
  assert.equal(
    output.choices.find((c) => c.id === "c2c3")?.label,
    "RISK -5: c3"
  )
  assert.ok(output.prompt.includes("opponent Nc2+, you Ke2, opponent Nxa1"))
  assert.ok(output.prompt.includes("opponent Nxb3, you cxb3, opponent Qxd5"))
  assert.ok(output.prompt.includes("Turn: you."))
  assert.ok(!output.prompt.includes("FEN state ("))
  assert.equal(
    output.systemPrompt,
    systemPromptFor(game, TACTICAL_PROMPT_VERSION)
  )
  assert.deepEqual(game, saved)
  for (const choice of output.choices) {
    const capture = choice.outcome.match(
      /CHECKED EXCHANGE net (-?\d+): ([^;]+)/
    )
    if (!capture) continue
    const b = new Chess(game.fen),
      before = material(b)
    b.move(choice.id)
    for (const [i, turn] of capture[2].split(", ").entries()) {
      const actor = i % 2 ? "you " : "opponent "
      assert.ok(turn.startsWith(actor))
      b.move(turn.slice(actor.length))
    }
    assert.equal(material(b) - before, Number(capture[1]))
  }
})
test("all orders and both roles retain exact legal actions and clear decoded state", () => {
  for (const fixture of RECORDED_CASES.slice(0, 3)) {
    assert.ok(fixture.history)
    const game = fixture.history.reduce(applyMove, newGame(fixture.humanColor))
    const output = buildMoveAnalysis({
      game,
      promptVersion: TACTICAL_PROMPT_VERSION,
      moveOrder: fixture.orders[1]
    })
    assert.deepEqual(
      output.choices.map((c) => c.id),
      fixture.orders[1]
    )
    assert.ok(output.prompt.includes("Turn: you."))
    assert.equal(
      output.systemPrompt,
      systemPromptFor(game, TACTICAL_PROMPT_VERSION)
    )
  }
})
test("an initial queen gain is not erased by a later additional pawn capture", () => {
  const game = fromFen(
      "r2qkbnr/1pp2ppp/8/3Ppb2/2Bn4/Pq6/1PPP1PPP/RNBQK1NR w KQkq - 2 7",
      "black"
    ),
    saved = structuredClone(game)
  const board = new Chess(game.fen),
    before = material(board)
  for (const san of ["Bxb3", "Nxb3", "cxb3", "Qxd5"]) board.move(san)
  assert.equal(material(board) - before, 8)
  const moves = annotatedLegalMoves(game, {
    safety: true,
    exchangeTail: true,
    exchangeFollowupCapture: true
  })
  const choice = buildSharedPrompt({
    game,
    moves,
    currentThreats: currentThreats(game)
  }).choices.find((c) => c.id === "c4b3")
  assert.ok(choice)
  assert.equal(choice.label, "Bxb3")
  assert.deepEqual(game, saved)
})
test("incomplete exchange proofs never certify compensation or remove a legal action", () => {
  const game = actual(),
    moves = annotatedLegalMoves(game, { safety: true, exchangeTail: true }),
    move = moves.find((m) => m.id === "c4b3")
  assert.ok(move)
  move.outcome.exchangeFollowupUnresolved = true
  const output = buildSharedPrompt(
      {
        game,
        moves,
        currentThreats: currentThreats(game)
      },
      TACTICAL_PROMPT_VERSION
    ),
    choice = output.choices.find((c) => c.id === move.id)
  assert.ok(choice)
  assert.match(choice.outcome, /preview incomplete/)
  assert.ok(!choice.outcome.includes("COMPENSATING RECAPTURE"))
  const summary = output.prompt
    .split("\n")
    .find((l) => l.startsWith("CAPTURE AND FORK PREVIEW:"))
  assert.ok(summary)
  assert.ok(!summary.includes("Bb3"))
  assert.equal(output.choices.length, moves.length)
})
