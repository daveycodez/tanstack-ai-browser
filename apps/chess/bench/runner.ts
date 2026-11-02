import { promptApiModel } from "@tanstack-ai-browser/prompt-api"
import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove, fromFen, newGame } from "../src/lib/chess.ts"
import { opponentOption, resolveOpponent } from "../src/lib/opponents.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import { SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import { benchmarkOrder } from "./order.ts"
import { CASES } from "./cases.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"
declare const __CHESS_BENCH_REVISION__: string
export type BenchmarkOptions = {
  model: OpponentModel
  thinking: boolean
  repetitions: number
  caseIds?: string[]
  signal: AbortSignal
  onResult: (result: BenchmarkResult) => void
  onProgress?: (label: string) => void
}
/** Manual browser runs only. No saved-game access and no automatic model calls. */
export async function runBenchmark(
  options: BenchmarkOptions
): Promise<BenchmarkReport> {
  if (
    !Number.isInteger(options.repetitions) ||
    options.repetitions < 1 ||
    options.repetitions > 20
  )
    throw new RangeError("Repetitions must be 1–20.")
  const selected = options.caseIds ?? CASES.map((c) => c.id)
  const cases = CASES.filter((c) => selected.includes(c.id))
  if (!cases.length || cases.length !== new Set(selected).size)
    throw new Error("Unknown fixture selection.")
  const reasoningSupported = opponentOption(options.model).thinking !== "none"
  const opponent = resolveOpponent({
    model: options.model,
    thinking: options.thinking && reasoningSupported
  })
  const report: BenchmarkReport = {
    schemaVersion: 4,
    choiceIndexBase: 0,
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: "",
    revision: __CHESS_BENCH_REVISION__,
    partial: false,
    config: {
      ...opponent,
      ...(opponent.model === "prompt-api"
        ? { runtimeModel: promptApiModel() }
        : {}),
      requestedThinking: options.thinking,
      reasoningSupported,
      reasoningBudgetTokens: 512,
      maxOutputTokens: 8192,
      sampling: "model defaults",
      repetitions: options.repetitions,
      caseIds: cases.map((c) => c.id),
      suiteVersion: "audited-v2",
      outputContract: "legal-uci-enum-v1",
      promptVersion: SHARED_PROMPT_VERSION,
      orderPolicy: "recorded pair then deterministic novel permutations"
    },
    results: [],
    summary: {
      total: 0,
      legal: 0,
      passed: 0,
      scored: 0,
      firstOption: 0,
      medianSeconds: null
    }
  }
  const total = cases.length * options.repetitions
  outer: for (const testCase of cases)
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      if (options.signal.aborted) break outer
      const game = testCase.history
        ? testCase.history.reduce(applyMove, newGame())
        : fromFen(testCase.fen)
      if (game.fen !== testCase.fen)
        throw new Error(`Fixture history mismatch: ${testCase.id}`)
      game.opponent = opponent
      const controller = new AbortController()
      const abort = () => controller.abort(options.signal.reason)
      options.signal.addEventListener("abort", abort, { once: true })
      const result: BenchmarkResult = {
        trial: report.results.length + 1,
        repetition: repetition + 1,
        caseId: testCase.id,
        label: testCase.label,
        fen: game.fen,
        objective: testCase.description,
        expectedMoveIds: testCase.expectedMoveIds,
        partition: testCase.partition ?? "calibration",
        legal: false,
        passed: testCase.expectedMoveIds === null ? null : false,
        signal: testCase.signalMoveIds ? false : null,
        index: -1,
        total: 0,
        seconds: 0,
        choices: [],
        thinkingChars: 0,
        reasoningText: "",
        condition: testCase.condition
      }
      options.onProgress?.(`Trial ${result.trial}/${total}: ${testCase.label}`)
      const started = performance.now()
      try {
        result.moveId = await chooseAiMove(
          game,
          controller,
          (phase) =>
            options.onProgress?.(
              `Trial ${result.trial}/${total}: ${testCase.label} — ${phase}`
            ),
          (delta) => {
            result.reasoningText += delta
            result.thinkingChars += delta.length
          },
          {
            moveOrder: benchmarkOrder(testCase, repetition),
            onInput: (input) => {
              result.choices = input.choices
              result.prompt = input.prompt
              result.total = input.choices.length
            },
            onAnswer: (answer) => {
              result.rawAnswer = answer
            }
          }
        )
        result.legal = true
        result.index = result.choices.findIndex((c) => c.id === result.moveId)
        result.passed =
          testCase.expectedMoveIds === null
            ? null
            : testCase.expectedMoveIds.includes(result.moveId)
        result.signal = testCase.signalMoveIds
          ? testCase.signalMoveIds.includes(result.moveId)
          : null
      } catch (error) {
        if (options.signal.aborted) break outer
        result.error = error instanceof Error ? error.message : String(error)
      } finally {
        result.seconds = (performance.now() - started) / 1000
        options.signal.removeEventListener("abort", abort)
      }
      report.results.push(result)
      options.onResult(result)
    }
  const xs = report.results
  const times = xs.map((r) => r.seconds).sort((a, b) => a - b),
    mid = Math.floor(times.length / 2)
  report.summary = {
    total: xs.length,
    legal: xs.filter((r) => r.legal).length,
    passed: xs.filter((r) => r.passed === true).length,
    scored: xs.filter((r) => r.passed !== null).length,
    firstOption: xs.filter((r) => r.index === 0).length,
    medianSeconds: times.length
      ? times.length % 2
        ? times[mid]
        : (times[mid - 1] + times[mid]) / 2
      : null
  }
  report.partial = options.signal.aborted || xs.length !== total
  report.finishedAt = new Date().toISOString()
  return report
}
