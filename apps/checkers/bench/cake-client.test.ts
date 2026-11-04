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

test('requested Cake depth is forwarded and bounds the native result without changing the default', async () => {
  const game = newGame('black'), legal = legalMoves(game.board, game.turn)
  const successors = legal.map(move => { const next = applyMove(game, move.id); return cakePosition(next.board, next.turn) })
  const original = globalThis.fetch
  const requested: number[] = []
  let completed: number | undefined
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)); requested.push(input[5])
    return Response.json({ successor: successors[0], legalSuccessors: successors, score: 0, requestedDepth: input[5], completedDepth: completed ?? input[5], nodes: 1, cpuSeconds: 0, provenance: {} })
  }
  try {
    const controller = new AbortController()
    for (const depth of [1, 3, 5, 7]) assert.equal((await chooseCakeMove(game, controller.signal, depth)).requestedDepth, depth)
    assert.equal((await chooseCakeMove(game, controller.signal)).requestedDepth, 7)
    assert.deepEqual(requested, [1, 3, 5, 7, 7])
    completed = 3
    await assert.rejects(chooseCakeMove(game, controller.signal, 1), /invalid completed/)
    for (const invalid of [0, 2, -1, 27, NaN]) await assert.rejects(chooseCakeMove(game, controller.signal, invalid), /odd integer/)
    assert.equal(requested.length, 6, 'invalid settings never start native work')
  } finally { globalThis.fetch = original }
})
