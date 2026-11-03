import { promptApiModel } from "@tanstack-ai-browser/prompt-api"
import { chooseAiMove } from "../src/lib/ai.ts"
import { PREVIOUS_PROMPT_VERSION, SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import { OUTCOME_VERSION } from "../src/lib/move-outcomes.ts"
import { applyMove, legalMoves } from "../src/lib/checkers.ts"
import { opponentOption, resolveOpponent } from "../src/lib/opponents.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import { CASES, SUITE_VERSION, gameForCase } from "./cases.ts"
import type { BenchmarkReport, BenchmarkResult, PromptVersion } from "./types.ts"

declare const __CHECKERS_BENCH_REVISION__: string
export type BenchmarkOptions = {
  model: OpponentModel
  thinking: boolean
  repetitions: number
  promptVersion: PromptVersion
  reasoningBudgetTokens?: number
  caseIds?: string[]
  signal: AbortSignal
  onResult: (result: BenchmarkResult) => void
  onProgress?: (label: string) => void
  orderPolicy?: "paired" | "production"
}
export function benchmarkOrder(caseId: string, repetition: number, ids: readonly string[]): string[] {
  let seed = 2166136261
  for (const letter of `${caseId}:${repetition}`) seed = Math.imul(seed ^ letter.charCodeAt(0), 16777619) >>> 0
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  const order = [...ids]
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[order[index], order[other]] = [order[other], order[index]]
  }
  return order
}
export function summarize(results: readonly BenchmarkResult[]): BenchmarkReport["summary"] {
  const times = results.filter(result => result.inference).map(result => result.seconds).sort((a, b) => a - b)
  const middle = Math.floor(times.length / 2)
  const scored = results.filter(result => result.passed !== null && result.inference)
  return { total: results.length, inferred: times.length, legal: results.filter(result => result.legal).length, scored: scored.length, passed: scored.filter(result => result.passed).length, firstOption: results.filter(result => result.inference && result.index === 0).length, medianSeconds: times.length ? times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 : null }
}

/** Explicit browser runs only. It calls production inference without touching saved games. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 20) throw new RangeError("Repetitions must be between 1 and 20.")
  if (!["baseline-v1", PREVIOUS_PROMPT_VERSION, SHARED_PROMPT_VERSION].includes(options.promptVersion)) throw new Error("Unknown prompt version.")
  const budget = options.reasoningBudgetTokens ?? 512
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError("Reasoning budget must be a nonnegative safe integer.")
  const selected = options.caseIds ?? CASES.filter(testCase => testCase.partition === "calibration").map(testCase => testCase.id)
  const cases = CASES.filter(testCase => selected.includes(testCase.id))
  if (!cases.length || cases.length !== new Set(selected).size) throw new Error("Unknown or empty case selection.")
  const opponent = resolveOpponent({ model: options.model, thinking: options.thinking && opponentOption(options.model).thinking !== "none" })
  const report: BenchmarkReport = {
    schemaVersion: 1, runId: crypto.randomUUID(), startedAt: new Date().toISOString(), finishedAt: "", revision: __CHECKERS_BENCH_REVISION__, partial: false,
    config: { ...opponent,
      ...(opponent.model === "prompt-api" && { runtimeModel: promptApiModel() }),
      reasoningMode: !opponent.thinking ? "off" : opponent.model === "prompt-api" ? "emulated-working-notes" : "native",
      reasoningBudgetTokens: budget, maxOutputTokens: opponent.model === "prompt-api" ? null : 8192, sampling: "model defaults", promptCache: "long",
      repetitions: options.repetitions, caseIds: cases.map(testCase => testCase.id), suiteVersion: SUITE_VERSION, promptVersion: options.promptVersion,
      ...(options.promptVersion !== "baseline-v1" && { outcomeVersion: OUTCOME_VERSION }),
      orderPolicy: options.orderPolicy === "production" ? "production per-game stable action priorities" : "case/repetition seeded permutations, identical across models and prompt versions", outputContract: options.promptVersion === "baseline-v1" ? "legal-moveId-enum" : "legal-action-label-enum" },
    results: [], summary: summarize([])
  }
  const execute = async () => {
    outer: for (const testCase of cases) for (let repetition = 0; repetition < options.repetitions; repetition++) {
      if (options.signal.aborted) break outer
      const game = gameForCase(testCase)
      game.opponent = opponent
      if (options.orderPolicy === "production") game.sessionId = `checkers-suite-${testCase.id}-${repetition}`
      const moves = legalMoves(game.board, "ai")
      const result: BenchmarkResult = {
        trial: report.results.length + 1, repetition: repetition + 1, caseId: testCase.id, label: testCase.label, objective: testCase.description,
        partition: testCase.partition, expectedMoveIds: testCase.expectedMoveIds, position: structuredClone(game),
        legal: false, passed: testCase.expectedMoveIds === null || moves.length === 1 ? null : false,
        signal: testCase.signalMoveIds ? false : null, inference: moves.length !== 1, index: -1, seconds: 0, choices: [], reasoningText: ""
      }
      const started = performance.now()
      options.onProgress?.(`Trial ${result.trial}/${cases.length * options.repetitions}: ${testCase.label}`)
      const controller = new AbortController()
      const abort = () => controller.abort(options.signal.reason)
      options.signal.addEventListener("abort", abort, { once: true })
      try {
        result.moveId = await chooseAiMove(game, controller,
          phase => options.onProgress?.(`Trial ${result.trial}: ${testCase.label} — ${phase}`),
          delta => { result.reasoningText += delta },
          { promptVersion: options.promptVersion, reasoningBudgetTokens: budget, ...(options.orderPolicy !== "production" && { moveOrder: benchmarkOrder(testCase.id, repetition, moves.map(move => move.id)) }),
            onInput(input) { result.choices = input.choices; result.prompt = input.prompt; result.systemPrompt = input.systemPrompt },
            onAnswer(answer) { result.rawAnswer = answer }, onUsage(usage) { result.usage = usage } })
        options.signal.throwIfAborted()
        applyMove(game, result.moveId)
        result.legal = true
        result.index = result.choices.findIndex(choice => choice.id === result.moveId)
        result.passed = testCase.expectedMoveIds === null || !result.inference ? null : testCase.expectedMoveIds.includes(result.moveId)
        result.signal = testCase.signalMoveIds ? testCase.signalMoveIds.includes(result.moveId) : null
      } catch (error) {
        if (options.signal.aborted) { report.partial = true; break outer }
        result.error = error instanceof Error ? error.message : String(error)
      } finally {
        options.signal.removeEventListener("abort", abort)
        result.seconds = (performance.now() - started) / 1000
      }
      report.results.push(result)
      report.summary = summarize(report.results)
      options.onResult(result)
    }
  }
  try {
    if (navigator.locks) await navigator.locks.request("checkers-ai-turn", { signal: options.signal }, execute)
    else await execute()
  } catch (error) {
    if (!options.signal.aborted) throw error
  }
  report.partial ||= options.signal.aborted
  report.finishedAt = new Date().toISOString()
  report.summary = summarize(report.results)
  return report
}
