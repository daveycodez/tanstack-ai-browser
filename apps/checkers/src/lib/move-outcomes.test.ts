import assert from "node:assert/strict"
import test from "node:test"
import { CASES, gameForCase } from "../../bench/cases.ts"
import { acceptedChoices, balance, inspectChoices, responseBalance } from "../../bench/audit.ts"
import { applyMove, legalMoves, squareName } from "./checkers.ts"
import type { Game } from "./checkers.ts"
import { annotateMoves, describeMove, material, materialBalance, moveLabel } from "./move-outcomes.ts"
import type { AnnotatedMove } from "./move-outcomes.ts"
import { buildBaselinePrompt, buildMovePrompt, buildSharedPrompt, SHARED_PROMPT_VERSION, SHARED_SYSTEM_PROMPT } from "./shared-prompt.ts"

const sorted = (ids: readonly string[]) => [...ids].sort()
const find = (id: string) => {
  const fixture = CASES.find(item => item.id === id)
  assert.ok(fixture, `Missing fixture ${id}`)
  return gameForCase(fixture)
}
const sameIds = (actual: readonly string[], expected: readonly string[], message?: string) => assert.deepEqual(sorted(actual), sorted(expected), message)
const count = (game: Game, side: Game["turn"], king: boolean) => game.board.filter(piece => piece?.side === side && piece.king === king).length

for (const fixture of CASES) {
  test(`outcomes match the rule-only audit: ${fixture.id}`, () => {
    const game = gameForCase(fixture)
    const original = JSON.stringify(game)
    const legal = legalMoves(game.board, "ai")
    const annotated = annotateMoves(game)
    const reference = inspectChoices(game)
    assert.deepEqual(annotated.map(move => move.id), legal.map(move => move.id))
    assert.equal(new Set(annotated.map(move => move.label)).size, legal.length)
    assert.equal(materialBalance(game.board), balance(game.board))
    assert.equal(material(game.board, "ai") - material(game.board, "human"), balance(game.board))
    for (const move of annotated) {
      const audited = reference.find(choice => choice.id === move.id)
      assert.ok(audited)
      const facts = move.outcome
      const after = applyMove(game, move.id)
      assert.equal(facts.status, audited.status)
      assert.equal(facts.promoted, audited.promotes)
      assert.equal(facts.capturedValue, audited.capturedValue)
      assert.equal(facts.captured.length, audited.captures)
      assert.equal(facts.allowsRedWin, audited.humanWins)
      assert.equal(facts.forcesWinNextTurn, audited.forcesWin)
      assert.equal(facts.moverCanBeCaptured, audited.replies.some(reply => reply.capturesMover))
      assert.equal(facts.redPromotionReplies, audited.replies.filter(reply => reply.promotes).length)
      assert.equal(facts.worstNetAfterResponse, audited.worstNet)
      assert.equal(facts.materialAfter, balance(after.board))
      assert.equal(facts.immediateGain, balance(after.board) - balance(game.board))
      assert.deepEqual(facts.black, { men: count(after, "ai", false), kings: count(after, "ai", true) })
      assert.deepEqual(facts.red, { men: count(after, "human", false), kings: count(after, "human", true) })
      assert.deepEqual(facts.captured, move.captures.map(square => ({ square, king: game.board[square]?.king, value: game.board[square]?.king ? 2 : 1 })))
      assert.equal(facts.quietPlies, after.quietMoves)
      assert.equal(facts.repetitionCount, after.positions.filter(position => position === after.positions.at(-1)).length)
      sameIds(facts.redReplies.map(reply => reply.id), audited.replies.map(reply => reply.id))
      const redLegal = after.status === "playing" ? legalMoves(after.board, "human") : []
      assert.equal(facts.redMovablePieces, new Set(redLegal.map(reply => reply.path[0])).size)
      assert.equal(facts.maxRedCaptureCount, Math.max(0, ...redLegal.map(reply => reply.captures.length)))
      assert.equal(facts.maxRedCaptureValue, Math.max(0, ...redLegal.map(reply => reply.captures.reduce((sum, square) => sum + (after.board[square]?.king ? 2 : 1), 0))))
      sameIds(facts.worstReplyIds, audited.replies.filter(reply => reply.net === audited.worstNet).map(reply => reply.id))
      for (const reply of facts.redReplies) {
        const expected = audited.replies.find(item => item.id === reply.id)
        const red = redLegal.find(item => item.id === reply.id)
        assert.ok(expected && red)
        assert.equal(reply.status, expected.status)
        assert.equal(reply.promotes, expected.promotes)
        assert.equal(reply.takesMover, expected.capturesMover)
        assert.equal(reply.netAfterBestResponse, expected.net)
        sameIds(reply.aiWinningReplies, expected.aiWins)
        assert.deepEqual(reply.captures, red.captures.map(square => ({ square, king: after.board[square]?.king, value: after.board[square]?.king ? 2 : 1 })))
        const redGame = applyMove(after, red.id)
        const responses = redGame.status === "playing" ? legalMoves(redGame.board, "ai").map(response => ({ id: response.id, net: responseBalance(applyMove(redGame, response.id), game.board) - balance(game.board) })) : []
        sameIds(reply.bestResponseIds, responses.filter(response => response.net === expected.net).map(response => response.id))
      }
      const startingPiece = game.board[move.path[0]]
      assert.ok(startingPiece)
      assert.equal(move.label, moveLabel(move, startingPiece))
      for (const square of move.path) assert.ok(move.label.includes(squareName(square)), "labels describe the entire chain")
      assert.equal(move.label.includes("become king"), move.promotes)
    }
    assert.equal(JSON.stringify(game), original, "annotation must not mutate persisted board/history")
  })
}

test("accepted tactical objectives can be recovered from the annotated facts without hiding alternatives", () => {
  for (const fixture of CASES) {
    const game = gameForCase(fixture)
    const moves = annotateMoves(game)
    const safe = (move: AnnotatedMove) => !move.outcome.allowsRedWin && move.outcome.status !== "draw"
    let accepted: string[] | null = null
    if (fixture.objective === "win-now") accepted = moves.filter(move => move.outcome.status === "ai-won").map(move => move.id)
    if (fixture.objective === "avoid-immediate-loss") accepted = moves.filter(move => !move.outcome.allowsRedWin).map(move => move.id)
    if (fixture.objective === "best-safe-exchange") {
      const candidates = moves.filter(move => safe(move) && move.captures.length > 0)
      const best = Math.max(...candidates.map(move => move.outcome.worstNetAfterResponse))
      accepted = candidates.filter(move => move.outcome.worstNetAfterResponse === best).map(move => move.id)
    }
    if (fixture.objective === "avoid-losing-exchange") accepted = moves.filter(move => safe(move) && move.outcome.worstNetAfterResponse >= 0).map(move => move.id)
    if (fixture.objective === "best-runner-defense") {
      const candidates = moves.filter(move => safe(move) && move.outcome.worstNetAfterResponse >= 0)
      const best = Math.max(...candidates.map(move => move.outcome.worstNetAfterResponse))
      accepted = candidates.filter(move => move.outcome.worstNetAfterResponse === best).map(move => move.id)
    }
    if (fixture.objective === "safe-promotion") accepted = moves.filter(move => safe(move) && move.promotes && !move.outcome.moverCanBeCaptured && move.outcome.worstNetAfterResponse >= 0).map(move => move.id)
    if (fixture.objective === "prevent-promotion") accepted = moves.filter(move => safe(move) && move.outcome.redPromotionReplies === 0 && move.outcome.worstNetAfterResponse >= 0).map(move => move.id)
    if (fixture.objective === "force-win-next-turn") accepted = moves.filter(move => move.outcome.forcesWinNextTurn).map(move => move.id)
    if (fixture.objective === "force-next-capture") {
      const candidates = moves.filter(move => move.outcome.status === "playing" && !move.outcome.allowsRedWin && move.outcome.redReplies.length > 0 && move.outcome.redReplies.every(reply => reply.status === "playing" && reply.nextCaptureValue > 0))
      const best = Math.max(0, ...candidates.map(move => move.outcome.minNextCaptureValue))
      accepted = best ? candidates.filter(move => move.outcome.minNextCaptureValue === best).map(move => move.id) : []
    }
    if (fixture.objective === "avoid-draw-ahead") accepted = moves.filter(move => safe(move) && move.outcome.status === "playing" && move.outcome.worstNetAfterResponse >= 0).map(move => move.id)
    if (fixture.objective === "take-draw-behind") accepted = moves.filter(move => move.outcome.status === "draw").map(move => move.id)
    assert.deepEqual(accepted && sorted(accepted), acceptedChoices(game, fixture.objective)?.sort() ?? null)
    const prompt = buildSharedPrompt(game, moves)
    assert.equal(prompt.choices.length, legalMoves(game.board, "ai").length, "no objective prunes legal cards")
  }
})

test("all board prompts are model agnostic and preserve the caller's complete move order", () => {
  for (const fixture of CASES) {
    const game = gameForCase(fixture)
    const moves = legalMoves(game.board, "ai").reverse()
    const native = { ...game, opponent: { model: "LiquidAI/LFM3-1.7B-GGUF" as const, thinking: false } }
    const nano = { ...game, opponent: { model: "prompt-api" as const, thinking: true } }
    for (const version of ["baseline-v1", SHARED_PROMPT_VERSION] as const) {
      const first = buildMovePrompt(native, moves, version)
      const second = buildMovePrompt(nano, moves, version)
      assert.deepEqual(first, second)
      assert.deepEqual(first.choices.map(choice => choice.id), moves.map(move => move.id))
      assert.equal(new Set(first.choices.map(choice => choice.label)).size, moves.length)
      let cursor = -1
      for (const choice of first.choices) {
        const next = first.prompt.indexOf(choice.outcome, cursor + 1)
        assert.ok(next > cursor, `cards preserve explicit order in ${fixture.id}`)
        cursor = next
      }
    }
  }
})

test("complete Red multi-jumps and exposure of another Black checker remain explicit", () => {
  const danger = annotateMoves(find("avoid-fatal-double-jump")).filter(move => move.outcome.allowsRedWin)
  assert.ok(danger.length > 0)
  assert.ok(danger.some(move => move.outcome.redReplies.some(reply => reply.status === "human-won" && reply.captures.length >= 2)))
  for (const move of danger) assert.match(describeMove(move), /RED CAN WIN NEXT/)
  const promotions = annotateMoves(find("promotion-not-at-any-cost")).filter(move => move.promotes)
  assert.ok(promotions.some(move => move.outcome.worstNetAfterResponse < 0))
  assert.ok(promotions.every(move => !move.outcome.moverCanBeCaptured), "a crowned edge king cannot be immediately jumped")
  const exposed = promotions.find(move => move.outcome.maxRedCaptureCount > 0)
  assert.ok(exposed)
  assert.match(describeMove(exposed), /another Black piece is exposed/)
})

test("material facts include captured kings and newly gained kings at all three plies", () => {
  const choices = annotateMoves(find("capture-king-value"))
  assert.ok(choices.some(move => move.outcome.captured.some(piece => piece.king && piece.value === 2)))
  const crowned = annotateMoves(find("safe-crowning")).filter(move => move.promotes)
  assert.ok(crowned.length > 0)
  assert.ok(crowned.every(move => move.outcome.immediateGain === move.outcome.capturedValue + 1))
  const redPromotions = CASES.flatMap(fixture => annotateMoves(gameForCase(fixture))).flatMap(move => move.outcome.redReplies).filter(reply => reply.promotes)
  assert.ok(redPromotions.length > 0, "the cross-case reference checks exercise opponent promotions")
  let responsePromotion = false
  for (const fixture of CASES) {
    const game = gameForCase(fixture)
    for (const move of legalMoves(game.board, "ai")) {
      const after = applyMove(game, move.id)
      if (after.status !== "playing") continue
      for (const reply of legalMoves(after.board, "human")) {
        const red = applyMove(after, reply.id)
        if (red.status === "playing" && legalMoves(red.board, "ai").some(response => response.promotes)) responsePromotion = true
      }
    }
  }
  assert.equal(responsePromotion, true, "the independent leaf accounting exercises Black response promotions")
})

test("king activity, latest-own-turn reversal, and actual repetition metadata do not pretend to be forced tactics", () => {
  const kingGame = find("king-activity")
  const kingMoves = annotateMoves(kingGame)
  assert.ok(kingMoves.every(move => move.outcome.kingDistanceBefore === 6))
  assert.equal(kingMoves.find(move => move.id === "b4-c5")?.outcome.kingDistanceAfter, 5)
  assert.equal(kingMoves.find(move => move.id === "b4-a5")?.outcome.kingDistanceAfter, 7)
  assert.ok(kingMoves.every(move => /King distance to nearest Red/.test(describeMove(move))))
  assert.match(buildSharedPrompt(kingGame, kingMoves).prompt, /King distance is only a quiet activity hint, not safety/)
  const repetition = annotateMoves(find("avoid-third-repeat-ahead")).find(move => move.id === "a3-b4")
  assert.ok(repetition)
  assert.equal(repetition.outcome.reversesLastOwnMove, true)
  assert.equal(repetition.outcome.repetitionCount, 3)
  assert.equal(repetition.outcome.status, "draw")
  assert.match(describeMove(repetition), /third repetition/)
  const withoutHistory = { ...find("avoid-third-repeat-ahead"), history: [] }
  assert.equal(annotateMoves(withoutHistory).find(move => move.id === "a3-b4")?.outcome.reversesLastOwnMove, false)
  const partialHistory = { ...find("avoid-third-repeat-ahead"), history: find("avoid-third-repeat-ahead").history.slice(-1) }
  assert.equal(partialHistory.history[0].side, "human")
  assert.equal(annotateMoves(partialHistory).find(move => move.id === "a3-b4")?.outcome.reversesLastOwnMove, false)
})

test("baseline formatting retains the original coordinate contract, headings, capture counts and last-five-turn window", () => {
  const game = find("avoid-third-repeat-ahead")
  const moves = legalMoves(game.board, "ai")
  const baseline = buildBaselinePrompt(game, moves)
  assert.equal(baseline.systemPrompt, "")
  assert.match(baseline.prompt, /^Play American checkers as AI\./)
  assert.match(baseline.prompt, /AI pieces: .*K/)
  assert.ok(baseline.prompt.includes("Human pieces:"))
  assert.ok(baseline.prompt.includes("Last 5 moves (oldest first):"))
  assert.ok(baseline.prompt.includes("Legal moves (id: path; number captured; promotion):"))
  assert.ok(baseline.prompt.endsWith("Return only JSON with moveId equal to one of these legal ids."))
  assert.deepEqual(baseline.choices.map(choice => choice.label), moves.map(move => move.id))
  const historyText = baseline.prompt.split("Last 5 moves (oldest first):\n")[1].split("\nLegal moves")[0]
  assert.deepEqual(historyText.split("\n"), game.history.slice(-5).map(move => `${move.side === "human" ? "Human" : "AI"}: ${move.notation}`))
  const forced = find("forced-full-chain")
  const chain = buildBaselinePrompt(forced, legalMoves(forced.board, "ai"))
  assert.ok(chain.prompt.includes("b6xd4xf2: b6-d4-f2; 2; -"))
})

test("shared prompt uses one concise system instruction and describes independent bounded alternatives", () => {
  const game = find("opening-variety")
  const prompt = buildSharedPrompt(game, annotateMoves(game))
  assert.equal(prompt.systemPrompt, SHARED_SYSTEM_PROMPT)
  assert.match(prompt.systemPrompt, /Each card is a separate alternative/)
  assert.match(prompt.prompt, /bounded preview does not prove a positional win/)
  assert.match(prompt.prompt, /activity hint, not safety/)
  assert.match(prompt.prompt, /Returning to an earlier square can be necessary/)
  assert.match(prompt.prompt, /Return exactly one JSON object with key "move"/)
  assert.equal(prompt.choices.length, legalMoves(game.board, "ai").length)
})


test("benchmark replay metadata preserves each custom initial board and turn", () => {
  const game = find("avoid-third-repeat-ahead")
  const initial = Reflect.get(game, "initialBoard") as Game["board"]
  assert.ok(Array.isArray(initial))
  assert.equal(Reflect.get(game, "initialTurn"), "human")
  assert.deepEqual(initial[33], { side: "ai", king: true }, "the original king begins on b4")
  assert.equal(initial[40], null, "a3 becomes occupied only after legal replay")
  assert.deepEqual(game.board[40], { side: "ai", king: true })
  assert.notEqual(initial, game.board)
})


test("quiet progress remains an optional observation and never masks immediate tactics", () => {
  const king = find("king-activity")
  const choices = annotateMoves(king)
  const prompt = buildSharedPrompt(king, choices)
  const progress = prompt.prompt.split("\n").find(line => line.startsWith("SAFE QUIET PROGRESS:"))
  assert.ok(progress)
  assert.match(progress, /Move king b4 to c[35]/)
  assert.doesNotMatch(progress, /Move king b4 to a[35]/)
  assert.equal(prompt.choices.length, 4, "less active legal moves remain selectable")
  assert.match(progress, /not a forced win/)
  for (const id of ["win-full-chain", "safe-crowning", "force-next-turn-win"]) {
    const game = find(id)
    assert.doesNotMatch(buildSharedPrompt(game, annotateMoves(game)).prompt, /SAFE QUIET PROGRESS:/)
  }
})
