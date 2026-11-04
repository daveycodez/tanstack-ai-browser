import assert from 'node:assert/strict'
import test from 'node:test'
import { CASES, gameForCase } from './cases.ts'
import { auditCase } from './audit.ts'
import { annotateMoves, materialBalance } from '../src/lib/move-outcomes.ts'
import { buildMovePrompt, checkedPriorityChoices } from '../src/lib/shared-prompt.ts'
const game = (id: string) => { const fixture = CASES.find(c => c.id === id); assert.ok(fixture); return { fixture, state: gameForCase(fixture) } }

test('the repeated opening error avoids extra exposed material only after checked returns tie', () => {
  const { fixture, state } = game('cake1-limit-double-jump-exposure'), moves = annotateMoves(state)
  assert.equal(materialBalance(state.board), 0)
  const bad = moves.find(m => m.id === 'e7-f6'); assert.ok(bad)
  assert.equal(bad.outcome.maxRedCaptureValue, 2); assert.equal(bad.outcome.worstNetAfterResponse, -1)
  const current = checkedPriorityChoices(state, moves)
  assert.ok(current.length > 0); assert.ok(current.every(m => m.outcome.worstNetAfterResponse === -1 && m.outcome.maxRedCaptureValue === 1))
  assert.ok(!current.some(m => m.id === bad.id))
  assert.deepEqual(checkedPriorityChoices(state, moves, true, true, true, false).map(m => m.id), ['e7-f6'])
  assert.ok(!auditCase(fixture).expectedMoveIds?.includes('e7-f6'))
  assert.equal(buildMovePrompt(state).choices.length, moves.length)
  assert.equal(buildMovePrompt(state).systemPrompt, buildMovePrompt(state, undefined, 'shared-v16').systemPrompt)
})
test('ahead draw avoidance permits a checked cost only if a positive lead remains', () => {
  const { fixture, state } = game('cake1-keep-checked-lead-over-draw'), moves = annotateMoves(state)
  assert.equal(materialBalance(state.board), 2)
  const offered = moves.find(m => m.id === 'e3-f4'); assert.ok(offered)
  assert.ok(offered.outcome.redReplies.some(reply => reply.status === 'draw'))
  assert.ok(moves.every(m => m.outcome.worstNetAfterResponse < 0))
  const current = checkedPriorityChoices(state, moves)
  assert.deepEqual(new Set(current.map(m => m.id)), new Set(['f2-e1', 'f2-g1']))
  assert.ok(current.every(m => materialBalance(state.board) + m.outcome.worstNetAfterResponse > 0 && !m.outcome.allowsCheckedLoss && !m.outcome.allowsOpponentDraw))
  assert.ok(checkedPriorityChoices(state, moves, true, true, true, false).some(m => m.id === 'e3-f4'))
  assert.deepEqual(new Set(auditCase(fixture).expectedMoveIds), new Set(current.map(m => m.id)))
})
