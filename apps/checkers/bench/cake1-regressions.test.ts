import assert from 'node:assert/strict'
import test from 'node:test'
import { CASES, gameForCase } from './cases.ts'
import { auditCase } from './audit.ts'
import { applyMove, legalMoves, colorForSide } from '../src/lib/checkers.ts'
import { annotateMoves } from '../src/lib/move-outcomes.ts'
import { shortEndgameWins } from '../src/lib/endgame-finishes.ts'
import { buildMovePrompt, checkedPriorityChoices } from '../src/lib/shared-prompt.ts'
const fixture = (id: string) => { const found = CASES.find(c => c.id === id); assert.ok(found); return found }

test('recorded calibration histories start White first and replay their real draw counters', () => {
  for (const id of ['cake1-recapture-bait','cake1-finish-lone-king','cake1-dont-offer-draw-ahead']) {
    const game = gameForCase(fixture(id))
    assert.equal(game.turn, 'ai'); assert.equal(game.humanColor, 'black'); assert.equal(game.initialTurn, 'ai')
    assert.equal(colorForSide(game, game.initialTurn), 'white'); assert.equal(game.positions.length, game.history.length + 1)
    assert.ok(auditCase(fixture(id)).expectedMoveIds?.length)
  }
})
test('recapture follow-up catches the forced double jump without rejecting supported trades', () => {
  const game = gameForCase(fixture('cake1-recapture-bait')), before = JSON.stringify(game)
  const old = annotateMoves(game, undefined, false).find(m => m.id === 'h6-g5'), now = annotateMoves(game).find(m => m.id === 'h6-g5')
  assert.ok(old && now); assert.equal(old.outcome.worstNetAfterResponse, 0); assert.equal(now.outcome.worstNetAfterResponse, -1)
  assert.equal(now.outcome.tradeFollowUpChecked, true)
  assert.deepEqual(now.outcome.redReplies[0].exchangeLine, ['b4xd6','c7xe5','g3-f4','e5xg3','h2xf4xh6'])
  assert.ok(!checkedPriorityChoices(game, annotateMoves(game)).some(m => m.id === 'h6-g5'))
  assert.equal(JSON.stringify(game), before)
  assert.ok(auditCase(fixture('reported-exchange-move-28')).expectedMoveIds?.includes('d6-c5'))
})
test('the lone-king finish is a proof against all defenses, with draws terminating the proof', () => {
  const game = gameForCase(fixture('cake1-finish-lone-king')), before = JSON.stringify(game)
  assert.deepEqual([...shortEndgameWins(game)], ['e3-d4'])
  assert.deepEqual(checkedPriorityChoices(game, annotateMoves(game)).map(m => m.id), ['e3-d4'])
  assert.equal(shortEndgameWins({ ...game, quietMoves: 79 }).has('e3-d4'), false, 'cannot claim a finish beyond a quiet-clock draw')
  assert.deepEqual([...shortEndgameWins({ ...game, status: 'draw' })], [])
  assert.equal(JSON.stringify(game), before)
})
test('ahead draw policy includes the opponent reply without excluding all other legal cards', () => {
  const game = gameForCase(fixture('cake1-dont-offer-draw-ahead')), moves = annotateMoves(game)
  const offered = moves.find(m => m.id === 'g3-f2'); assert.ok(offered)
  assert.ok(offered.outcome.redReplies.some(reply => reply.status === 'draw'))
  const current = checkedPriorityChoices(game, moves).map(m => m.id)
  assert.ok(!current.includes('g3-f2')); assert.ok(!current.includes('g3-f4')); assert.ok(current.length > 0)
  assert.ok(checkedPriorityChoices(game, moves, true, false).some(m => m.id === 'g3-f2'))
  const prompt = buildMovePrompt(game); assert.equal(prompt.choices.length, legalMoves(game.board, 'ai').length)
  assert.match(prompt.choices.find(c => c.id === 'g3-f2')?.outcome ?? '', /Human can claim an immediate draw/)
  const after = applyMove(game, 'g3-f2'); assert.ok(legalMoves(after.board, after.turn).some(m => applyMove(after, m.id).status === 'draw'))
})

test('a capture line that blocks every surviving piece is a checked terminal loss, not a material preference', () => {
  const game = gameForCase({ id: 'checked-blockade', label: 'checked-blockade', description: 'Recorded first-validation error', objective: 'diagnostic', partition: 'calibration', humanColor: 'black', setup: { black: ['g5','d4','f4','e3','g3'], red: ['c5K','h2','c1','e1','g1'] }, expectedMoveIds: null })
  const move = annotateMoves(game).find(m => m.id === 'e3-f2'); assert.ok(move)
  assert.equal(move.outcome.allowsRedWin, false, 'the first opponent capture does not itself end the game')
  assert.equal(move.outcome.allowsCheckedLoss, true)
  let line = applyMove(game, 'e3-f2'); line = applyMove(line, 'c5xe3')
  assert.deepEqual(legalMoves(line.board, line.turn).map(m => m.id), ['f4xd2'])
  line = applyMove(line, 'f4xd2'); line = applyMove(line, 'h2xf4xh6')
  assert.equal(line.status, 'human-won'); assert.equal(line.board.filter(p => p?.side === 'ai').length, 2, 'loss is blockade, not zero material')
  assert.ok(!checkedPriorityChoices(game, annotateMoves(game)).some(m => m.id === 'e3-f2'))
  assert.deepEqual(checkedPriorityChoices(game, annotateMoves(game, undefined, true, false), true, true, false, false).map(m => m.id), ['e3-f2'], 'historical material-only behavior is retained for v15')
  assert.match(buildMovePrompt(game).choices.find(c => c.id === 'e3-f2')?.outcome ?? '', /Human can force a terminal win/)
})
