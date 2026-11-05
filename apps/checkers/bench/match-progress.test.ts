import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMatchScore } from './match-progress.ts'

test('live match score updates after each completed game and excludes self-play controls', () => {
  const results = [
    { policy: 'model', status: 'ai-won' },
    { policy: 'model', status: 'human-won' },
    { policy: 'model', status: 'draw' },
    { policy: 'cake', status: 'ai-won' }
  ] as const
  assert.equal(formatMatchScore([]), 'AI 0W-0L-0D')
  assert.equal(formatMatchScore(results.slice(0, 1)), 'AI 1W-0L-0D')
  assert.equal(formatMatchScore(results.slice(0, 2)), 'AI 1W-1L-0D')
  assert.equal(formatMatchScore(results), 'AI 1W-1L-1D')
})
test('live scoring never turns unfinished or failed games into losses or draws', () => {
  assert.equal(formatMatchScore([{ policy: 'model', status: 'playing' }]), 'AI 0W-0L-0D')
  assert.equal(formatMatchScore([{ policy: 'model', status: 'capped' }, { policy: 'model', status: 'error' }, { policy: 'model', status: 'stopped' }]), 'AI 0W-0L-0D; 1 unfinished; 2 errors/stopped')
})
