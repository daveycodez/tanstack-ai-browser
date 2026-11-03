import { chooseAiMove } from '../src/lib/ai.ts'
import { applyMove, colorForSide, legalMoves, newGame } from '../src/lib/checkers.ts'
import type { Side } from '../src/lib/checkers.ts'
import type { OpponentModel } from '../src/lib/opponents.ts'
import { SHARED_PROMPT_VERSION } from '../src/lib/shared-prompt.ts'
import { CASES, gameForCase, SUITE_VERSION } from './cases.ts'
import { auditCakePosition, chooseCakeMove, cakeMetadata, CAKE_DEPTH } from './cake-client.ts'
import { createBlindReviewPair, profileBehaviorTrace } from './behavior-style.ts'
import type { BehaviorStyleTrace } from './behavior-style.ts'

export const STANDARD_MAX_PLIES = 120
export const STANDARD_REVIEW_PLIES = 40
export type StandardTrace = BehaviorStyleTrace & {
  policy: 'model' | 'cake'; seed: string
  moves: { ply: number; side: Side; moveId: string; source: 'model' | 'cake' | 'forced' }[]
  error?: string
}
export type StandardStudyOptions = { model: OpponentModel; signal: AbortSignal; onProgress?: (message: string) => void }
export type StandardStudyReport = Awaited<ReturnType<typeof runStandardStudy>>
export async function runStandardStudy(options: StandardStudyOptions) {
  options.signal.throwIfAborted()
  const metadata = await cakeMetadata(options.signal), startedAt = new Date().toISOString(), runId = crypto.randomUUID()
  const tactics: { id: string; modelMove: string; cakeMove: string; modelPass: boolean | null; cakePass: boolean | null; inferred: boolean }[] = []
  const traces: StandardTrace[] = []
  const controller = new AbortController(), abort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort()
  try {
    for (const fixture of CASES) {
      options.signal.throwIfAborted()
      const game = gameForCase(fixture); game.opponent = { model: options.model, thinking: false }
      options.onProgress?.(`Skill: ${fixture.id} · ${tactics.length + 1}/${CASES.length}`)
      const cake = await chooseCakeMove(game, options.signal), modelMove = await chooseAiMove(game, controller)
      tactics.push({ id: fixture.id, modelMove, cakeMove: cake.moveId, modelPass: fixture.expectedMoveIds ? fixture.expectedMoveIds.includes(modelMove) : null, cakePass: fixture.expectedMoveIds ? fixture.expectedMoveIds.includes(cake.moveId) : null, inferred: legalMoves(game.board, game.turn).length > 1 })
    }
    for (const humanColor of ['white', 'black'] as const) for (const seed of ['style-game-a', 'style-game-b']) for (const policy of ['model', 'cake'] as const) {
      let game = newGame(humanColor); game.sessionId = `${seed}-${humanColor}`; game.opponent = { model: options.model, thinking: false }
      const initialTurn = game.turn, moves: StandardTrace['moves'] = []
      let errorText: string | undefined
      try {
        for (let ply = 1; ply <= STANDARD_MAX_PLIES && game.status === 'playing'; ply++) {
          options.signal.throwIfAborted()
          options.onProgress?.(`${policy === 'model' ? 'Our AI' : 'Cake control'} · ${humanColor} human · ${seed} · ply ${ply}/${STANDARD_MAX_PLIES}`)
          const legal = legalMoves(game.board, game.turn), side = game.turn
          const source = legal.length === 1 ? 'forced' : side === 'human' || policy === 'cake' ? 'cake' : 'model'
          const moveId = source === 'forced' ? legal[0].id : source === 'cake' ? (await chooseCakeMove(game, options.signal)).moveId : await chooseAiMove(game, controller)
          options.signal.throwIfAborted()
          if (!legal.some(move => move.id === moveId)) throw new Error('A comparison opponent returned an illegal action.')
          moves.push({ ply, side, moveId, source }); game = applyMove(game, moveId)
        }
      } catch (error) { errorText = error instanceof Error ? error.message : String(error) }
      traces.push({ id: `${policy}:${humanColor}:${seed}`, policy, seed, humanColor, initialTurn, moves, finalGame: game,
        status: options.signal.aborted ? 'stopped' : errorText ? 'error' : game.status === 'playing' ? 'capped' : game.status, ...(errorText ? { error: errorText } : {}) })
      if (options.signal.aborted) break
    }
    const profiles = []
    for (const trace of traces) {
      let game = newGame(trace.humanColor)
      const quality = []
      for (const move of trace.moves) {
        options.signal.throwIfAborted()
        if (move.side === 'ai' && legalMoves(game.board, game.turn).length > 1) {
          options.onProgress?.(`Auditing decision quality: ${trace.id} · ply ${move.ply}`)
          const audit = await auditCakePosition(game, options.signal), chosen = audit.find(item => item.id === move.moveId)
          if (!chosen) throw new Error('Cake audit omitted the actual move.')
          quality.push({ ply: move.ply, regret: chosen.regret })
        }
        game = applyMove(game, move.moveId)
      }
      profiles.push({ id: trace.id, policy: trace.policy, profile: profileBehaviorTrace(trace, { quality, qualitySource: 'Cake native MTD(f) candidate audit, effective root depth 7; uncalibrated native score units' }) })
    }
    const blindPairs = []
    for (const humanColor of ['white', 'black'] as const) for (const seed of ['style-game-a', 'style-game-b']) {
      const model = traces.find(trace => trace.policy === 'model' && trace.humanColor === humanColor && trace.seed === seed), cake = traces.find(trace => trace.policy === 'cake' && trace.humanColor === humanColor && trace.seed === seed)
      if (model && cake && !['error', 'stopped'].includes(model.status) && !['error', 'stopped'].includes(cake.status)) {
        const count = Math.min(STANDARD_REVIEW_PLIES, model.moves.length, cake.moves.length)
        blindPairs.push(createBlindReviewPair({ id: `${humanColor}:${seed}`, a: { label: options.model, trace: { ...model, moves: model.moves.slice(0, count), status: 'capped' } }, b: { label: 'Cake', trace: { ...cake, moves: cake.moves.slice(0, count), status: 'capped' } }, salt: runId }))
      }
    }
    const scored = tactics.filter(item => item.modelPass !== null && item.inferred)
    return { schemaVersion: 1, protocol: 'existing-engine-human-style-v1', runId, startedAt, finishedAt: new Date().toISOString(),
      model: options.model, suiteVersion: SUITE_VERSION, standardEngine: metadata, searchDepth: CAKE_DEPTH, promptVersion: SHARED_PROMPT_VERSION, thinking: false, sampling: 'model defaults', maxPlies: STANDARD_MAX_PLIES, blindReviewPlies: STANDARD_REVIEW_PLIES,
      partial: options.signal.aborted || traces.length !== 8 || traces.some(trace => trace.status === 'error' || trace.status === 'stopped'), tactics,
      skill: { model: { passed: scored.filter(item => item.modelPass).length, total: scored.length }, cake: { passed: scored.filter(item => item.cakePass).length, total: scored.length },
        matches: traces.filter(trace => trace.policy === 'model').map(trace => ({ id: trace.id, aiColor: colorForSide(trace.finalGame, 'ai'), result: trace.status, plies: trace.moves.length })) },
      profiles, traces, blindPairs,
      interpretation: 'Actual existing non-LLM Cake engine versus the production LLM opponent. Style profiles are descriptive; human-like scores require explicit blinded human ratings. Match results measure this configuration, not Elo. Capped games are unresolved, not draws.' }
  } finally { options.signal.removeEventListener('abort', abort) }
}
