import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove, legalMoves } from "../src/lib/checkers.ts"
import { orderMovesForGame } from "../src/lib/move-order.ts"
import { SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import { runBenchmark } from "./runner.ts"
import { CASES } from "./cases.ts"
import { WEBGL_MODEL_META } from "@tanstack-ai-browser/webgllm"
import { promptApiModel } from "@tanstack-ai-browser/prompt-api"
import { BEHAVIOR_PROTOCOL_VERSION, BEHAVIOR_REPEATS, prepareBehaviorPositions } from "./behavior-positions.ts"
import { createBehaviorReference } from "./behavior-reference.ts"
import { runBehaviorRollouts } from "./behavior-rollouts.ts"
import { summarizeBehavior, successorStateKey } from "./behavior-metrics.ts"
import type { BehaviorObservation, BehaviorPosition } from "./behavior-metrics.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import type { PromptInput } from "../src/lib/shared-prompt.ts"

export type BehaviorStudyOptions = { model: OpponentModel; signal: AbortSignal; onProgress?: (message: string) => void }
export type BehaviorStudyReport = Awaited<ReturnType<typeof runBehaviorStudy>>
const hashInput = async (input: PromptInput) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([input.systemPrompt, input.prompt, input.choices.map(choice => choice.label)])))), byte => byte.toString(16).padStart(2, "0")).join("")
const randomIndex = (text: string, count: number) => {
  let hash = 2166136261
  for (const letter of text) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15
  return (hash >>> 0) % count
}
function controlObservations(name: "canonical-engine" | "near-best-random" | "legal-random", positions: BehaviorPosition[]): BehaviorObservation[] {
  const rows: BehaviorObservation[] = []
  for (const condition of ["fixed", "game-seeded"] as const) for (const position of positions) for (let repetition = 0; repetition < BEHAVIOR_REPEATS; repetition++) {
    const legal = legalMoves(position.game.board, "ai")
    const order = orderMovesForGame(condition === "fixed" ? `behavior-fixed-${position.id}` : `behavior-game-${position.id}-${repetition}`, legal)
    const candidates = name === "canonical-engine" ? position.reference4.bestMoveIds.slice(0, 1)
      : name === "near-best-random" ? position.reference4.moves.filter(move => move.regret <= 25 && !position.unsafeMoveIds.includes(move.id)).map(move => move.id)
        : position.reference4.moves.map(move => move.id)
    const moveId = candidates[randomIndex(`${name}:${position.id}:${condition}:${repetition}`, candidates.length)]
    rows.push({ positionId: position.id, condition, repetition, moveId, legal: !!moveId,
      successorKey: moveId ? successorStateKey(applyMove(position.game, moveId)) : undefined,
      inputHash: condition === "fixed" ? `fixed-${position.id}` : `seeded-${position.id}-${repetition}`,
      firstCardId: order[0]?.id, firstRecommendedId: order.find(move => position.recommendedIds.includes(move.id))?.id })
  }
  return rows
}
export async function runBehaviorStudy(options: BehaviorStudyOptions) {
  options.signal.throwIfAborted()
  const runId = crypto.randomUUID(), startedAt = new Date().toISOString()
  const reference = createBehaviorReference(options.signal)
  const observations: BehaviorObservation[] = []
  const inputs: Record<string, PromptInput> = {}
  try {
    options.onProgress?.("Preparing independent reference positions…")
    const positions = await prepareBehaviorPositions(reference, options.signal)
    options.onProgress?.("Running the current tactical skill suite…")
    const tactical = await runBenchmark({ model: options.model, thinking: false, repetitions: 1, promptVersion: SHARED_PROMPT_VERSION, orderPolicy: "production", caseIds: CASES.map(item => item.id), isolationKey: runId, signal: options.signal, onResult(result) { options.onProgress?.(`Skill: ${result.trial}/${CASES.length} completed`) }, onProgress: message => options.onProgress?.(`Skill: ${message}`) })
    options.signal.throwIfAborted()
    const controlTactics: Record<string, { passed: number; total: number }> = {}
    for (const name of ["canonical-engine", "near-best-random", "legal-random"] as const) {
      const score = { passed: 0, total: 0 }
      for (const item of tactical.results.filter(item => item.inference && item.expectedMoveIds !== null)) {
        const ref = await reference.evaluate(item.position, { depth: 4 })
        const candidates = name === "canonical-engine" ? ref.bestMoveIds.slice(0, 1) : name === "near-best-random" ? ref.moves.filter(move => move.regret <= 25).map(move => move.id) : ref.moves.map(move => move.id)
        const selected = candidates[randomIndex(`${name}:${item.caseId}`, candidates.length)]
        score.total++; if (selected && item.expectedMoveIds?.includes(selected)) score.passed++
      }
      controlTactics[name] = score
    }
    for (const condition of ["fixed", "game-seeded"] as const) for (const position of positions) for (let repetition = 0; repetition < BEHAVIOR_REPEATS; repetition++) {
      options.signal.throwIfAborted()
      const game = structuredClone(position.game)
      game.opponent = { model: options.model, thinking: false }
      const legal = legalMoves(game.board, "ai")
      const moveOrder = orderMovesForGame(condition === "fixed" ? `behavior-fixed-${position.id}` : `behavior-game-${position.id}-${repetition}`, legal).map(move => move.id)
      let captured: PromptInput | undefined
      const row: BehaviorObservation = { positionId: position.id, condition, repetition, legal: false }
      options.onProgress?.(`${condition}: ${position.id} · ${repetition + 1}/${BEHAVIOR_REPEATS}`)
      try {
        const controller = new AbortController(), abort = () => controller.abort(options.signal.reason)
        options.signal.addEventListener("abort", abort, { once: true })
        try {
          row.moveId = await chooseAiMove(game, controller, undefined, undefined, { moveOrder, onInput(input) { captured = input } })
          options.signal.throwIfAborted()
          row.legal = legal.some(move => move.id === row.moveId)
          if (row.legal && row.moveId) row.successorKey = successorStateKey(applyMove(game, row.moveId))
        } finally { options.signal.removeEventListener("abort", abort) }
      } catch (error) {
        if (options.signal.aborted) throw error
        row.error = error instanceof Error ? error.message : String(error)
      }
      if (captured) {
        row.inputHash = await hashInput(captured)
        inputs[row.inputHash] = captured
        row.firstCardId = captured.choices[0]?.id
        row.firstRecommendedId = captured.choices.find(choice => position.recommendedIds.includes(choice.id))?.id
      }
      observations.push(row)
    }
    const summary = summarizeBehavior(observations, positions, { passed: tactical.summary.passed, total: tactical.summary.scored })
    const controls = Object.fromEntries((["canonical-engine", "near-best-random", "legal-random"] as const).map(name => [name, summarizeBehavior(controlObservations(name, positions), positions, controlTactics[name])]))
    for (const position of positions) {
      const fixed = observations.filter(row => row.positionId === position.id && row.condition === "fixed")
      if (new Set(fixed.map(row => row.inputHash).filter(Boolean)).size > 1) throw new Error(`${position.id}: exact-repeat inputs changed.`)
    }
    options.onProgress?.("Playing capped trajectories against the deterministic opponent…")
    const rollouts = await runBehaviorRollouts({ model: options.model, signal: options.signal, reference, onProgress: options.onProgress })
    return { schemaVersion: 1, protocolVersion: BEHAVIOR_PROTOCOL_VERSION, runId, model: options.model, startedAt, finishedAt: new Date().toISOString(), promptVersion: SHARED_PROMPT_VERSION, thinking: false, sampling: "model defaults", modelDefaults: options.model in WEBGL_MODEL_META ? WEBGL_MODEL_META[options.model as keyof typeof WEBGL_MODEL_META].sampling : null, runtimeModel: options.model === "prompt-api" ? promptApiModel() : undefined, promptCache: "long", maxOutputTokens: options.model === "prompt-api" ? null : 8192, repeats: BEHAVIOR_REPEATS,
      summary, controls, positions, observations, inputs, tactical, rollouts,
      interpretation: "Skill and quality-preserving variety are separate operational scores. They do not establish human-likeness, creativity or emergence. Reference search is a finite-depth heuristic comparator, not an oracle." }
  } finally { reference.dispose() }
}
