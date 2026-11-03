import assert from 'node:assert/strict'
import test from 'node:test'
import { cakePosition, matchCakeMove, chooseCakeMove } from './cake-client.ts'
import { applyMove, legalMoves, newGame } from '../src/lib/checkers.ts'

test('Cake mapping preserves roles and unsigned high bits independently of displayed colors', () => {
  const white = newGame('white'), black = newGame('black')
  assert.deepEqual(cakePosition(white.board, 'ai'), cakePosition(black.board, 'ai'))
  const board = Array.from({ length: 64 }, () => null) as typeof white.board
  board[1] = { side: 'ai', king: true }; board[62] = { side: 'human', king: false }
  assert.deepEqual(cakePosition(board, 'human'), [8, 0, 0, 0x10000000, 2])
})
test('Cake must match the complete authoritative successor set, not merely return a legal-looking choice', () => {
  const game = newGame('black'), moves = legalMoves(game.board, game.turn)
  const legalSuccessors = moves.map(move => { const next = applyMove(game, move.id); return cakePosition(next.board, next.turn) })
  assert.equal(matchCakeMove(game, { successor: legalSuccessors[2], legalSuccessors }), moves[2].id)
  assert.throws(() => matchCakeMove(game, { successor: legalSuccessors[2], legalSuccessors: legalSuccessors.slice(1) }), /disagree/)
  assert.throws(() => matchCakeMove(game, { successor: [0, 0, 0, 0, 2], legalSuccessors }), /not legal/)
})
test('already cancelled Cake requests never start native work', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(chooseCakeMove(newGame('white'), controller.signal), { name: 'AbortError' })
})
