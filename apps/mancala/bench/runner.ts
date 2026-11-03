import { CASES, gameForCase, SUITE_VERSION } from "./cases.ts"
import { legalMoves } from "../src/lib/mancala.ts"
import { resolveOpponent, usesEmulatedReasoning } from "../src/lib/opponents.ts"
import type { PromptVersion } from "../src/lib/shared-prompt.ts"
import { SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import type { chooseAiMove } from "../src/lib/ai.ts"
import type { OpponentSettings } from "../src/lib/opponents.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"

declare const __MANCALA_BENCH_REVISION__: string
export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}
export function summarize(
  results: BenchmarkResult[]
): BenchmarkReport["summary"] {
  const inferred = results.filter((result) => result.inference)
  const scored = inferred.filter((result) => result.passed !== null)
  return {
    total: results.length,
    inferred: inferred.length,
    legal: results.filter((result) => result.legal).length,
    scored: scored.length,
    passed: scored.filter((result) => result.passed).length,
    firstOption: inferred.filter((result) => result.pit === result.order[0])
      .length,
    medianSeconds: median(inferred.map((result) => result.seconds))
  }
}
export function pairedOrder(moves: number[], repetition: number): number[] {
  const offset = Math.floor(repetition / 2) % moves.length
  const rotated = [...moves.slice(offset), ...moves.slice(0, offset)]
  return repetition % 2 ? rotated.reverse() : rotated
}
export type RunOptions = {
  opponent: OpponentSettings
  promptVersion?: PromptVersion
  repetitions: number
  reasoningBudgetTokens: number
  caseIds: string[]
  signal: AbortSignal
  onResult?: (result: BenchmarkResult) => void
  onProgress?: (message: string) => void
  chooseMove?: typeof chooseAiMove
}

export async function runBenchmark(
  options: RunOptions
): Promise<BenchmarkReport> {
  if (
    !Number.isSafeInteger(options.repetitions) ||
    options.repetitions < 1 ||
    options.repetitions > 20
  )
    throw new RangeError("Choose between 1 and 20 repetitions.")
  if (
    !Number.isSafeInteger(options.reasoningBudgetTokens) ||
    options.reasoningBudgetTokens < 0
  )
    throw new RangeError("Reasoning budget must be a nonnegative integer.")
  if (
    new Set(options.caseIds).size !== options.caseIds.length ||
    !options.caseIds.length ||
    options.caseIds.some((id) => !CASES.some((testCase) => testCase.id === id))
  )
    throw new Error("Choose valid, distinct benchmark positions.")
  const cases = options.caseIds.map((id) => {
    const testCase = CASES.find((candidate) => candidate.id === id)
    if (!testCase) throw new Error(`Unknown benchmark case: ${id}`)
    return testCase
  })
  const results: BenchmarkResult[] = []
  const startedAt = new Date().toISOString()
  const opponent = resolveOpponent(options.opponent)
  const choose =
    options.chooseMove ?? (await import("../src/lib/ai.ts")).chooseAiMove
  const runId = crypto.randomUUID()
  for (const testCase of cases) {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      if (options.signal.aborted) break
      const position = gameForCase(
        testCase,
        opponent,
        `${runId}:${testCase.id}:${repetition}`
      )
      const moves = legalMoves(position.board, "ai")
      const order = pairedOrder(moves, repetition)
      const controller = new AbortController()
      const cancel = () => controller.abort(options.signal.reason)
      options.signal.addEventListener("abort", cancel, { once: true })
      const result: BenchmarkResult = {
        trial: results.length + 1,
        repetition: repetition + 1,
        caseId: testCase.id,
        label: testCase.label,
        objective: testCase.objective,
        partition: testCase.partition,
        position,
        order,
        expectedPits: testCase.expectedPits,
        legal: false,
        passed: testCase.expectedPits ? false : null,
        inference: moves.length > 1,
        seconds: 0,
        reasoning: ""
      }
      options.onProgress?.(
        `${testCase.label} · repetition ${repetition + 1} of ${options.repetitions}`
      )
      const started = performance.now()
      try {
        result.pit = await choose(
          position,
          controller,
          undefined,
          (delta) => {
            result.reasoning += delta
          },
          {
            promptVersion: options.promptVersion,
            reasoningBudgetTokens: options.reasoningBudgetTokens,
            moveOrder: order,
            onInput: (input) => {
              result.input = input
            },
            onAnswer: (answer) => {
              result.rawAnswer = answer
            },
            onUsage: (usage) => {
              result.usage = usage
            }
          }
        )
        if (options.signal.aborted) break
        result.legal = moves.includes(result.pit)
        result.passed = testCase.expectedPits
          ? result.legal && testCase.expectedPits.includes(result.pit)
          : null
      } catch (error) {
        if (options.signal.aborted) break
        result.error = error instanceof Error ? error.message : String(error)
      } finally {
        result.seconds = (performance.now() - started) / 1000
        options.signal.removeEventListener("abort", cancel)
      }
      results.push(result)
      options.onResult?.(result)
    }
    if (options.signal.aborted) break
  }
  return {
    schemaVersion: 1,
    suiteVersion: SUITE_VERSION,
    promptVersion: options.promptVersion ?? SHARED_PROMPT_VERSION,
    revision:
      typeof __MANCALA_BENCH_REVISION__ === "string"
        ? __MANCALA_BENCH_REVISION__
        : "unreported",
    startedAt,
    finishedAt: new Date().toISOString(),
    partial:
      options.signal.aborted ||
      results.length !== cases.length * options.repetitions,
    config: {
      opponent,
      reasoningMode: !opponent.thinking
        ? "off"
        : usesEmulatedReasoning(opponent.model)
          ? "emulated-working-notes"
          : "native",
      repetitions: options.repetitions,
      reasoningBudgetTokens: options.reasoningBudgetTokens,
      caseIds: options.caseIds.slice(),
      orderPolicy: "paired-rotation-v1",
      sampling: "model defaults",
      promptCache: "long",
      maxOutputTokens: opponent.model === "prompt-api" ? null : 8192,
      userAgent: typeof navigator === "undefined" ? "test" : navigator.userAgent
    },
    results,
    summary: summarize(results)
  }
}
