import { browserModel } from "../src/lib/browser-model.ts"
import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove, fromFen, newGame } from "../src/lib/chess.ts"
import { isWebGlOpponent, opponentOption, resolveOpponent, usesEmulatedReasoning } from "../src/lib/opponents.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import type { PromptVersion } from "../src/lib/shared-prompt.ts"
import { isPromptVersion, SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import { benchmarkOrder } from "./order.ts"
import { BENCHMARK_CASES as CASES, SUITE_VERSION } from "./catalog.ts"
import { assessMove } from "./assess-move.ts"
import { CACHE_REPLAY_CASES } from "./cache-replay.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"
declare const __CHESS_BENCH_REVISION__: string
export type BenchmarkOptions = {
  promptVersion?: PromptVersion
  model: OpponentModel
  thinking: boolean
  movePresentation?: "game" | "new-games" | "stress"
  moveOrderSeed?: string
  repetitions: number
  webglTemperature?: number
  disablePromptCache?: boolean
  otherGpuWorkload?: boolean
  reasoningBudgetTokens?: 512 | 1024 | null
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
  if (options.webglTemperature !== undefined && (!Number.isFinite(options.webglTemperature) || options.webglTemperature < 0 || options.webglTemperature > 2))
    throw new RangeError("WebGL temperature must be between 0 and 2.")
  const reasoningBudgetTokens =
    options.reasoningBudgetTokens === undefined ? 512 : options.reasoningBudgetTokens
  if (
    reasoningBudgetTokens !== null &&
    reasoningBudgetTokens !== 512 &&
    reasoningBudgetTokens !== 1024
  )
    throw new RangeError("Reasoning budget must be 512, 1024, or uncapped (null).")
  if (options.promptVersion !== undefined && !isPromptVersion(options.promptVersion)) throw new Error("Unknown prompt version.")
  const moveOrderSeed = options.moveOrderSeed ?? "chess-benchmark-v1"
  const selected = options.caseIds ?? CASES.map((c) => c.id)
  const cases = [...CASES, ...CACHE_REPLAY_CASES].filter((c) => selected.includes(c.id))
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
        ? { runtimeModel: browserModel() }
        : {}),
      requestedThinking: options.thinking,
      reasoningSupported,
      reasoningMode: !opponent.thinking
        ? "off"
        : usesEmulatedReasoning(opponent.model)
          ? "emulated-working-notes"
          : "native",
      reasoningBudgetTokens,
      maxOutputTokens: opponent.model === "prompt-api" ? null : 8192,
      sampling: isWebGlOpponent(opponent.model) && options.webglTemperature !== undefined ? "temperature override" : "model defaults",
      ...(isWebGlOpponent(opponent.model) && options.webglTemperature !== undefined && { webglTemperature: options.webglTemperature }),
      promptCache: options.disablePromptCache ? "none" : "default",
      timingComparable: !options.otherGpuWorkload,
      timingConditions: options.otherGpuWorkload ? "Other GPU workload active; timings are diagnostic only" : "No competing GPU workload declared",
      repetitions: options.repetitions,
      caseIds: cases.map((c) => c.id),
      suiteVersion: cases.every(c => c.id.startsWith("cache-"))
        ? "cache-replay-v1"
        : SUITE_VERSION,
      outputContract: "san-risk-enum-v14",
      promptVersion: options.promptVersion ?? SHARED_PROMPT_VERSION,
      moveOrderSeed,
      sessionPolicy: "one thread per run; new-games uses one thread per repetition",
      movePresentation: options.movePresentation ?? "game",
      orderPolicy: options.movePresentation === "stress"
        ? "recorded pair then deterministic novel permutations"
        : options.movePresentation === "new-games"
          ? "new-game seed per repetition; stable per-game priorities"
          : "stable per-game seeded priorities"
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
        ? testCase.history.reduce(applyMove, newGame(testCase.humanColor ?? "white"))
        : fromFen(testCase.fen, testCase.humanColor ?? "white")
      if (game.fen !== testCase.fen)
        throw new Error(`Fixture history mismatch: ${testCase.id}`)
      // Match gameplay: each turn/retry shares a clean provider prefix within a game.
      // The board remains request-local; the native structured adapter clones its base.
      game.sessionId = `bench-${report.runId}${options.movePresentation === "new-games" ? `-${repetition + 1}` : ""}`
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
        threadId: `chess-${game.sessionId}`,
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
            promptVersion: options.promptVersion,
            reasoningBudgetTokens,
            webglTemperature: options.webglTemperature,
            disablePromptCache: options.disablePromptCache,
            moveOrderSeed: options.movePresentation === "new-games"
              ? `${moveOrderSeed}:${repetition + 1}`
              : moveOrderSeed,
            ...(options.movePresentation === "stress"
              ? { moveOrder: benchmarkOrder(testCase, repetition) }
              : {}),
            onInput: (input) => {
              result.choices = input.choices
              result.prompt = input.prompt
              result.systemPrompt = input.systemPrompt
              result.total = input.choices.length
            },
            onUsage: (usage) => {
              result.usage = usage
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
        result.assessment = assessMove(testCase, result.moveId)
        result.signal = testCase.signalMoveIds
          ? testCase.signalMoveIds.includes(result.moveId)
          : null
      } catch (error) {
        if (options.signal.aborted) break outer
        result.error = error instanceof Error ? error.message : String(error)
        result.assessment = { verdict: "ungraded", basis: "runtime", reason: "Operational error; no chess judgment." }
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
    outcomes: {
      acceptable: xs.filter(r => r.assessment?.verdict === "acceptable").length,
      mistake: xs.filter(r => r.assessment?.verdict === "mistake").length,
      uncertain: xs.filter(r => r.assessment?.verdict === "uncertain").length,
      ungraded: xs.filter(r => !r.assessment || r.assessment.verdict === "ungraded").length
    },
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
