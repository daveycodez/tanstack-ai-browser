import assert from "node:assert/strict"
import test from "node:test"
import { auditCase } from "../../bench/audit.ts"
import { CASES, gameForCase } from "../../bench/cases.ts"
import { EXCHANGE_REGRESSIONS } from "../../bench/exchange-regressions.ts"
import { applyMove, legalMoves } from "./checkers.ts"
import { annotateMoves, describeMove, materialBalance } from "./move-outcomes.ts"
import { buildMovePrompt } from "./shared-prompt.ts"

const reported = (ply: number) => {
  const fixture = EXCHANGE_REGRESSIONS.find(item => item.id === `reported-exchange-move-${ply}`)
  assert.ok(fixture)
  return { fixture, game: gameForCase(fixture) }
}

test("reported positions replay the real opening and accept every nonlosing alternative", () => {
  for (const ply of [6, 28]) {
    const { fixture, game } = reported(ply)
    assert.equal(game.history.length, ply - 1)
    assert.equal(game.turn, "ai")
    assert.equal(game.status, "playing")
    assert.equal(materialBalance(game.board), 0)
    assert.deepEqual(new Set(auditCase(fixture).expectedMoveIds), new Set(fixture.expectedMoveIds))
    assert.equal(fixture.objective, "avoid-losing-exchange")
  }
})

test("move 6 counts Red's compulsory final recapture instead of claiming an even trade", () => {
  const { fixture, game } = reported(6)
  const choices = annotateMoves(game)
  const losing = choices.find(move => move.id === "e5-f4")
  assert.ok(losing)
  assert.equal(losing.outcome.worstNetAfterResponse, -1)
  const reply = losing.outcome.redReplies.find(reply => reply.id === "g3xe5")
  assert.ok(reply)
  assert.equal(reply.netAfterBestResponse, -1)
  assert.deepEqual(reply.bestResponseIds, ["f6xd4"])
  assert.deepEqual(reply.exchangeLine.slice(0,3), ["g3xe5", "f6xd4", "c3xe5"])
  assert.equal(losing.outcome.redTurnsChecked, 2)
  assert.equal(choices.filter(move => move.outcome.worstNetAfterResponse >= 0).length, 7)
  assert.ok(!fixture.expectedMoveIds?.includes(losing.id))
  assert.match(describeMove(losing), /Black loses 1 points/)
  assert.match(describeMove(losing), /Red g3xe5 → Black f6xd4 → Red c3xe5/)
  const input = buildMovePrompt(game)
  assert.ok(input.choices.some(choice => choice.id === losing.id), "bad moves remain legal selectable alternatives")
  const safe = input.prompt.split("\n").reverse().find(line => line.startsWith("NON-LOSING CHECKED EXCHANGES:"))
  assert.ok(safe)
  assert.ok(!safe.includes(losing.label), "the losing exchange is no longer advertised as nonlosing")
})

test("move 28 preserves the even trade and counts the favorable double jump separately", () => {
  const { fixture, game } = reported(28)
  const choices = annotateMoves(game)
  const trade = choices.find(move => move.id === "d6-c5")
  assert.ok(trade)
  assert.equal(trade.outcome.moverCanBeCaptured, true)
  assert.equal(trade.outcome.worstNetAfterResponse, 0)
  const even = trade.outcome.redReplies.find(reply => reply.id === "d4xb6")
  const favorable = trade.outcome.redReplies.find(reply => reply.id === "b4xd6")
  assert.ok(even && favorable)
  assert.equal(even.netAfterBestResponse, 0)
  assert.deepEqual(even.exchangeLine, ["d4xb6", "a7xc5", "b4xd6", "e7xc5"])
  assert.equal(favorable.netAfterBestResponse, 0)
  assert.equal(annotateMoves(game, undefined, false).find(move => move.id === trade.id)?.outcome.redReplies.find(reply => reply.id === "b4xd6")?.netAfterBestResponse, 1)
  assert.deepEqual(favorable.exchangeLine.slice(0,2), ["b4xd6", "e7xc5xe3"])
  assert.ok(fixture.expectedMoveIds?.includes(trade.id))
  assert.equal(fixture.expectedMoveIds?.length, 5, "quiet alternatives pass too; the trade is not a favorite-move grade")
  assert.match(describeMove(trade), /breaks even at 0/)
  assert.match(describeMove(trade), /Red b4xd6 → Black e7xc5xe3 → Red e1-f2/)
})

test("every exchange witness replays legally, continues only compulsory captures beyond its declared horizon, and stops at quiet or terminal play", () => {
  let extended = 0
  let quietStops = 0
  let terminalStops = 0
  let promotionContinuations = 0
  let branchingContinuations = 0
  for (const fixture of CASES) {
    const game = gameForCase(fixture)
    const original = JSON.stringify(game)
    for (const move of annotateMoves(game)) {
      const after = applyMove(game, move.id)
      for (const reply of move.outcome.redReplies) {
        let current = after
        for (const [index, id] of reply.exchangeLine.entries()) {
          const legal = legalMoves(current.board, current.turn)
          const next = legal.find(move => move.id === id)
          assert.ok(next, `${fixture.id}: illegal exchange witness ${id}`)
          if (index >= 2 * move.outcome.redTurnsChecked) {
            assert.ok(next.captures.length > 0, "no extra quiet search beyond the stated reply/response horizon")
            assert.ok(legal.every(move => move.captures.length > 0))
            if (legal.length > 1) branchingContinuations++
            if (next.promotes) promotionContinuations++
          }
          current = applyMove(current, id)
        }
        assert.equal(reply.exchangeLine[0], reply.id)
        if (reply.exchangeLine.length > 2 * move.outcome.redTurnsChecked) extended++
        assert.equal(materialBalance(current.board) - materialBalance(game.board), reply.netAfterBestResponse)
        if (current.status === "playing") {
          quietStops++
          assert.ok(legalMoves(current.board, current.turn).every(move => move.captures.length === 0))
        } else terminalStops++
      }
    }
    assert.equal(JSON.stringify(game), original)
  }
  assert.ok(extended > 0, "suite exercises capture continuation beyond the previous horizon")
  assert.ok(quietStops > 0 && terminalStops > 0)
  assert.ok(promotionContinuations > 0, "crowning is respected inside extended captures")
  assert.ok(branchingContinuations > 0, "capture choices branch rather than blindly taking the first continuation")
})
