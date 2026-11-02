import { promptApiModel } from "@tanstack-ai-browser/prompt-api"
import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove, fromFen, newGame } from "../src/lib/chess.ts"
import { resolveOpponent } from "../src/lib/opponents.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import { PROMPT_STYLES } from "../src/lib/prompt-options.ts"
import { CONTEXT_VARIANTS } from "../src/lib/context-options.ts"
import { benchmarkOrder } from "./order.ts"
import { CASES } from "./cases.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"

declare const __CHESS_BENCH_REVISION__: string

export type BenchmarkOptions = {
  model: OpponentModel
  thinking: boolean
  queenValue: number
  repetitions: number
  promptStyleId?: string
  contextVariantId?: string
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
  const variantId = options.contextVariantId ?? "baseline"
  const variants =
    variantId === "all-variants"
      ? CONTEXT_VARIANTS
      : CONTEXT_VARIANTS.filter((v) => v.id === variantId)
  if (!variants.length) throw new Error("Unknown context variant.")
  const styleId = options.promptStyleId ?? "baseline"
  const styles =
    styleId === "highlight-compare"
      ? PROMPT_STYLES.filter(
          (style) =>
            style.id === "compact-safe-castle" ||
            style.id === "compact-highlights" ||
            style.id === "compact-copy"
        )
      : styleId === "compact-compare"
        ? PROMPT_STYLES.filter(
            (style) =>
              style.id === "compact" || style.id === "compact-safe-castle"
          )
        : styleId === "baseline-compact"
          ? PROMPT_STYLES.filter(
              (style) => style.id === "baseline" || style.id === "compact"
            )
          : styleId === "all-styles"
            ? PROMPT_STYLES
            : PROMPT_STYLES.filter((style) => style.id === styleId)
  if (!styles.length) throw new Error("Unknown prompt style.")
  const opponent = resolveOpponent({
    model: options.model,
    thinking: options.thinking
  })
  const report: BenchmarkReport = {
    schemaVersion: 3,
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
      queenValue: options.queenValue,
      repetitions: options.repetitions,
      caseIds: cases.map((c) => c.id),
      reasoningBudgetTokens: 1024,
      maxOutputTokens: 8192,
      sampling: styles.some((s) => s.repetitionPenalty !== undefined)
        ? "profile overrides"
        : "model defaults",
      orderPolicy: "recorded pair then deterministic novel permutations",
      promptStyleId: styleId,
      promptStyles: styles.map((s) => ({
        id: s.id,
        label: s.label,
        ...("repetitionPenalty" in s
          ? { repetitionPenalty: s.repetitionPenalty }
          : {})
      })),
      contextVariantId: variantId,
      contextVariants: variants.map((v) => ({ id: v.id, features: v.features }))
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
  const total =
    cases.length * options.repetitions * variants.length * styles.length
  outer: for (const testCase of cases) {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      for (const style of styles) {
        for (const variant of variants) {
          if (options.signal.aborted) break outer
          const game = testCase.history
            ? testCase.history.reduce(applyMove, newGame())
            : fromFen(testCase.fen)
          if (game.fen !== testCase.fen)
            throw new Error(
              `Fixture history does not match FEN: ${testCase.id}`
            )
          game.opponent = opponent
          const controller = new AbortController()
          const abort = () => controller.abort(options.signal.reason)
          options.signal.addEventListener("abort", abort, { once: true })
          const result: BenchmarkResult = {
            trial: report.results.length + 1,
            promptStyleId: style.id,
            promptStyleLabel: style.label,
            variantId: variant.id,
            variantLabel: variant.label,
            signal: null,
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
          options.onProgress?.(
            `Trial ${result.trial}/${total}: ${testCase.label} [${style.label}; ${variant.label}]`
          )
          const started = performance.now()
          try {
            result.moveId = await chooseAiMove(
              game,
              controller,
              (phase) =>
                options.onProgress?.(
                  `Trial ${result.trial}/${total}: ${testCase.label} [${style.label}; ${variant.label}] — ${phase}`
                ),
              (delta) => {
                result.thinkingChars += delta.length
              },
              {
                queenValue: options.queenValue,
                contextFeatures: variant.features,
                promptStyle: style.id,
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
            result.signal = testCase.signalMoveIds
              ? testCase.signalMoveIds.includes(result.moveId)
              : null
            result.index = result.choices.findIndex(
              (choice) => choice.id === result.moveId
            )
            result.passed =
              testCase.expectedMoveIds === null
                ? null
                : testCase.expectedMoveIds.includes(result.moveId)
          } catch (error) {
            if (options.signal.aborted) break outer
            result.error =
              error instanceof Error ? error.message : String(error)
          } finally {
            result.seconds = (performance.now() - started) / 1000
            options.signal.removeEventListener("abort", abort)
          }
          report.results.push(result)
          options.onResult(result)
        }
      }
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
  const median = (values: number[]) => {
    const sorted = values.sort((a, b) => a - b),
      mid = Math.floor(sorted.length / 2)
    return sorted.length
      ? sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2
      : null
  }
  const baseline = new Map(
    results
      .filter((r) => r.variantId === "baseline")
      .map((r) => [`${r.promptStyleId}:${r.caseId}:${r.repetition}`, r])
  )
  report.comparisons = variants
    .filter((v) => v.id !== "baseline")
    .map((variant) => {
      const current = results.filter((r) => r.variantId === variant.id)
      const pairs = current
        .map((r) => ({
          current: r,
          baseline: baseline.get(
            `${r.promptStyleId}:${r.caseId}:${r.repetition}`
          )
        }))
        .filter((p) => p.baseline)
      const scored = pairs.filter(
        (p) => p.current.passed !== null && p.baseline?.passed !== null
      )
      return {
        variantId: variant.id,
        pairedTactics: scored.length,
        improved: scored.filter((p) => !p.baseline?.passed && p.current.passed)
          .length,
        regressed: scored.filter((p) => p.baseline?.passed && !p.current.passed)
          .length,
        unchanged: scored.filter((p) => p.baseline?.passed === p.current.passed)
          .length,
        legalityRegressions: pairs.filter(
          (p) => p.baseline?.legal && !p.current.legal
        ).length,
        medianPromptChars: median(
          current.filter((r) => r.prompt).map((r) => r.prompt?.length ?? 0)
        ),
        medianSeconds: median(current.map((r) => r.seconds))
      }
    })
  const referenceStyleId = styles[0].id
  const references = new Map(
    results
      .filter((r) => r.promptStyleId === referenceStyleId)
      .map((r) => [`${r.variantId}:${r.caseId}:${r.repetition}`, r])
  )
  report.promptComparisons = styles.slice(1).map((style) => {
    const pairs = results
      .filter((r) => r.promptStyleId === style.id)
      .map((r) => ({
        current: r,
        reference: references.get(`${r.variantId}:${r.caseId}:${r.repetition}`)
      }))
      .filter((p) => p.reference)
    const scored = pairs.filter(
      (p) => p.current.passed !== null && p.reference?.passed !== null
    )
    return {
      referenceStyleId,
      promptStyleId: style.id,
      pairedTactics: scored.length,
      improved: scored.filter((p) => !p.reference?.passed && p.current.passed)
        .length,
      regressed: scored.filter((p) => p.reference?.passed && !p.current.passed)
        .length,
      unchanged: scored.filter((p) => p.reference?.passed === p.current.passed)
        .length,
      legalityRegressions: pairs.filter(
        (p) => p.reference?.legal && !p.current.legal
      ).length
    }
  })
  report.partial = options.signal.aborted || results.length !== total
  report.finishedAt = new Date().toISOString()
  return report
}
