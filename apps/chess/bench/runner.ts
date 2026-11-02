import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove, fromFen, newGame } from "../src/lib/chess.ts"
import { resolveOpponent } from "../src/lib/opponents.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import { CASES } from "./cases.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"

declare const __CHESS_BENCH_REVISION__: string

export type BenchmarkOptions = {
  model: OpponentModel
  thinking: boolean
  queenValue: number
  repetitions: number
  caseIds?: string[]
  signal: AbortSignal
  onResult: (result: BenchmarkResult) => void
  onProgress?: (label: string) => void
}

/** Explicit manual browser runs only; this runner is never imported by game routes. */
export async function runBenchmark(
  options: BenchmarkOptions
): Promise<BenchmarkReport> {
  if (
    !Number.isInteger(options.repetitions) ||
    options.repetitions < 1 ||
    options.repetitions > 20
  ) {
    throw new RangeError("Repetitions must be from 1 to 20.")
  }
  if (
    !Number.isInteger(options.queenValue) ||
    options.queenValue < 9 ||
    options.queenValue > 30
  ) {
    throw new RangeError("Queen priority must be from 9 to 30.")
  }
  const selected = options.caseIds ?? CASES.map((testCase) => testCase.id)
  const cases = CASES.filter((testCase) => selected.includes(testCase.id))
  if (!cases.length || cases.length !== new Set(selected).size)
    throw new Error("Unknown or empty fixture selection.")
  const opponent = resolveOpponent({
    model: options.model,
    thinking: options.thinking
  })
  const report: BenchmarkReport = {
    schemaVersion: 1,
    choiceIndexBase: 0,
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: "",
    revision: __CHESS_BENCH_REVISION__,
    partial: false,
    config: {
      ...opponent,
      queenValue: options.queenValue,
      repetitions: options.repetitions,
      caseIds: cases.map((c) => c.id),
      reasoningBudgetTokens: 1024,
      maxOutputTokens: 8192,
      sampling: "model defaults"
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
  outer: for (const testCase of cases) {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      if (options.signal.aborted) break outer
      const game = testCase.history
        ? testCase.history.reduce(applyMove, newGame())
        : fromFen(testCase.fen)
      if (game.fen !== testCase.fen)
        throw new Error(`Fixture history does not match FEN: ${testCase.id}`)
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
        legal: false,
        passed: testCase.expectedMoveIds === null ? null : false,
        index: -1,
        total: 0,
        seconds: 0,
        choices: [],
        thinkingChars: 0,
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
            result.thinkingChars += delta.length
          },
          {
            queenValue: options.queenValue,
            moveOrder: testCase.orders[repetition % testCase.orders.length],
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
        result.index = result.choices.findIndex(
          (choice) => choice.id === result.moveId
        )
        result.passed =
          testCase.expectedMoveIds === null
            ? null
            : testCase.expectedMoveIds.includes(result.moveId)
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
  }
  const results = report.results
  const times = results.map((r) => r.seconds).sort((a, b) => a - b)
  const middle = Math.floor(times.length / 2)
  report.summary = {
    total: results.length,
    legal: results.filter((r) => r.legal).length,
    passed: results.filter((r) => r.passed === true).length,
    scored: results.filter((r) => r.passed !== null).length,
    firstOption: results.filter((r) => r.index === 0).length,
    medianSeconds: times.length
      ? times.length % 2
        ? times[middle]
        : (times[middle - 1] + times[middle]) / 2
      : null
  }
  report.partial = options.signal.aborted || results.length !== total
  report.finishedAt = new Date().toISOString()
  return report
}
