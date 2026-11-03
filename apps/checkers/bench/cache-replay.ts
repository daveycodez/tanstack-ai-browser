import { promptApiModel } from "@tanstack-ai-browser/prompt-api"
import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove } from "../src/lib/checkers.ts"
import { PREVIOUS_PROMPT_VERSION, SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import { CASES, SUITE_VERSION } from "./cases.ts"
import { CACHE_REPLAY_SESSION as SESSION, cacheMetrics, cacheReplayPositions } from "./cache-replay-positions.ts"
import { runBenchmark } from "./runner.ts"
import type { CacheComparisonModel, CacheComparisonReport, CacheReplayReport, CacheReplayTrial } from "./types.ts"

export { cacheMetrics, cacheReplayPositions } from "./cache-replay-positions.ts"

declare const __CHECKERS_BENCH_REVISION__: string
export type CacheComparisonOptions = {
  model: CacheComparisonModel
  includeProductionOrder?: boolean
  /** False runs only the 28 recorded-game cache trials. */
  quality?: boolean
  signal: AbortSignal
  onUpdate: (report: CacheComparisonReport) => void
  onProgress?: (label: string) => void
}

/** Explicit browser protocol only; saved games, model sampling and engine defaults are untouched. */
export async function runCacheComparison(options: CacheComparisonOptions): Promise<CacheComparisonReport> {
  if (options.model !== "LiquidAI/LFM3-1.7B-GGUF" && options.model !== "prompt-api") throw new Error("Choose LFM3 GGUF or Prompt API.")
  const { positions, skippedForcedPlies } = cacheReplayPositions()
  const quality = options.quality !== false
  const includeProductionOrder = quality && options.includeProductionOrder !== false
  const report: CacheComparisonReport = {
    schemaVersion: 1, runId: crypto.randomUUID(), startedAt: new Date().toISOString(), finishedAt: "", revision: __CHECKERS_BENCH_REVISION__, partial: false, phase: quality ? "Preparing comparison" : "Preparing cache replay",
    config: { model: options.model, ...(options.model === "prompt-api" && { runtimeModel: promptApiModel() }), before: PREVIOUS_PROMPT_VERSION, after: SHARED_PROMPT_VERSION, reasoning: "off", reasoningBudgetTokens: 512, maxOutputTokens: options.model === "prompt-api" ? null : 8192, sampling: "model defaults", promptCache: "long", suiteVersion: SUITE_VERSION, caseIds: quality ? CASES.map(testCase => testCase.id) : [], quality, qualityRepetitions: quality ? 1 : 0, includeProductionOrder, sessionId: SESSION, selectedPlies: positions.map(game => game.history.length), skippedForcedPlies,
      notes: [
        quality ? "Quality uses every unchanged suite case with its existing expected moves; v6/v7 paired presentation orders match exactly." : "Cache-replay-only protocol: all quality passes are deliberately skipped.",
        "When enabled, both v6 and v7 also run quality controls with the same production per-game stable action-ordering algorithm.",
        "Cache replay follows recorded human/AI history, not model-generated continuations; each chosen position is sent twice before advancing.",
        "Both cache versions use the same sessionId and current production stable ordering. The v6 cache run controls ordering and is not its old random-order shipping behavior.",
        "No engine cache flags or cache flush are used. The first sample is not claimed cold; changed turns and exact repeats are separate observations.",
        "Missing provider cache/prefill counters remain null. For WebGL, its adapter omits cachedTokens when zero, which is recorded as zero. Prompt API cache/prefill counters are not invented."
      ] }, quality: [], cache: []
  }
  const update = (phase?: string) => { if (phase) { report.phase = phase; options.onProgress?.(phase) }; options.onUpdate({ ...report, quality: [...report.quality], cache: [...report.cache] }) }
  update()
  const qualityPlans = quality ? [
    { id: "v6-paired", label: `${PREVIOUS_PROMPT_VERSION} · paired quality`, version: PREVIOUS_PROMPT_VERSION, order: "paired" as const },
    { id: "v7-paired", label: `${SHARED_PROMPT_VERSION} · paired quality`, version: SHARED_PROMPT_VERSION, order: "paired" as const },
    ...(includeProductionOrder ? [
      { id: "v6-production", label: `${PREVIOUS_PROMPT_VERSION} · production-order quality`, version: PREVIOUS_PROMPT_VERSION, order: "production" as const },
      { id: "v7-production", label: `${SHARED_PROMPT_VERSION} · production-order quality`, version: SHARED_PROMPT_VERSION, order: "production" as const }
    ] : [])
  ] : []
  try {
    for (const plan of qualityPlans) {
      if (options.signal.aborted) break
      const phase = { id: plan.id, label: plan.label, totalTrials: CASES.length, results: [] } as CacheComparisonReport["quality"][number]
      report.quality.push(phase)
      update(plan.label)
      phase.report = await runBenchmark({ model: options.model, thinking: false, repetitions: 1, promptVersion: plan.version, reasoningBudgetTokens: 512, orderPolicy: plan.order, caseIds: report.config.caseIds, signal: options.signal,
        onResult(result) { phase.results?.push(result); update() },
        onProgress(label) { update(`${plan.label}: ${label}`) }
      })
      delete phase.results
      update()
    }
    if (!options.signal.aborted) {
      const execute = async () => {
        for (const version of [PREVIOUS_PROMPT_VERSION, SHARED_PROMPT_VERSION]) {
          if (options.signal.aborted) break
          const replay: CacheReplayReport = { promptVersion: version, orderPolicy: "production per-game stable action priorities for both versions", sessionId: SESSION, selectedPlies: report.config.selectedPlies, skippedForcedPlies, trials: [], partial: false }
          report.cache.push(replay)
          outer: for (const [sample, original] of positions.entries()) for (const attempt of [0, 1]) {
            if (options.signal.aborted) break outer
            const game = structuredClone(original)
            game.opponent = { model: options.model, thinking: false }
            const trial: CacheReplayTrial = { trial: replay.trials.length + 1, sample: sample + 1, ply: game.history.length, kind: attempt ? "exact-repeat" : sample ? "changed-turn" : "first-turn", promptVersion: version, sessionId: SESSION, position: structuredClone(game), choices: [], legal: false, seconds: 0, metrics: cacheMetrics(undefined, 0) }
            const controller = new AbortController()
            const abort = () => controller.abort(options.signal.reason)
            options.signal.addEventListener("abort", abort, { once: true })
            const started = performance.now()
            update(`${version} cache: ${trial.kind}, reported ply ${trial.ply} (${trial.trial}/14)`)
            try {
              trial.moveId = await chooseAiMove(game, controller, phase => update(`${version} cache: ply ${trial.ply} — ${phase}`), undefined, {
                promptVersion: version, reasoningBudgetTokens: 512,
                onInput(input) { trial.prompt = input.prompt; trial.systemPrompt = input.systemPrompt; trial.choices = input.choices },
                onAnswer(answer) { trial.rawAnswer = answer }, onUsage(usage) { trial.usage = usage }
              })
              options.signal.throwIfAborted()
              applyMove(game, trial.moveId)
              trial.legal = true
            } catch (error) {
              if (options.signal.aborted) { replay.partial = true; break outer }
              trial.error = error instanceof Error ? error.message : String(error)
            } finally {
              options.signal.removeEventListener("abort", abort)
              trial.seconds = (performance.now() - started) / 1000
              trial.metrics = cacheMetrics(trial.usage, trial.seconds * 1000, options.model)
            }
            replay.trials.push(trial)
            update()
          }
          replay.partial ||= options.signal.aborted
          update()
        }
      }
      if (navigator.locks) await navigator.locks.request("checkers-ai-turn", { signal: options.signal }, execute)
      else await execute()
    }
  } catch (error) {
    report.partial = true
    update()
    if (!options.signal.aborted) throw error
  } finally {
    report.partial ||= options.signal.aborted
    report.finishedAt = new Date().toISOString()
    update(report.partial ? "Comparison stopped; completed trials preserved." : (quality ? "Comparison complete." : "Cache replay complete."))
  }
  return report
}
