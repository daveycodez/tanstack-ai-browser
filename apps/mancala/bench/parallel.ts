import { runBenchmark } from "./runner.ts"
import type { RunOptions } from "./runner.ts"
import { runBenchmarkInFrame } from "./run-in-frame.ts"
import { resolveOpponent } from "../src/lib/opponents.ts"
import { SHARED_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"
import type { OpponentSettings } from "../src/lib/opponents.ts"
export const PARALLEL_MODELS = [
  "prompt-api",
  "LiquidAI/LFM3-1.7B-GGUF",
  "unsloth/Qwen3.5-2B-GGUF"
] as const
export type ParallelModel = (typeof PARALLEL_MODELS)[number]
export type ParallelSlot = {
  model: ParallelModel
  opponent: OpponentSettings
  results: BenchmarkResult[]
  report?: BenchmarkReport
  status: string
  error?: string
}
export type ParallelReport = {
  schemaVersion: 1
  mode: "mac-parallel"
  timingComparable: false
  timingConditions: string
  promptVersion: string
  startedAt: string
  finishedAt: string
  partial: boolean
  reports: ParallelSlot[]
}
export type ParallelOptions = Omit<
  RunOptions,
  "opponent" | "onResult" | "onProgress" | "chooseMove"
> & { thinking: boolean; onSlot: (slot: ParallelSlot) => void }
export type ParallelRunners = {
  prompt: typeof runBenchmark
  frame: typeof runBenchmarkInFrame
}
/** Parallelism is across isolated models; each model runs its own positions serially. */
export async function runParallelBenchmarks(
  options: ParallelOptions,
  runners: ParallelRunners = {
    prompt: runBenchmark,
    frame: runBenchmarkInFrame
  }
): Promise<ParallelReport> {
  options.signal.throwIfAborted()
  const startedAt = new Date().toISOString()
  const slots: ParallelSlot[] = PARALLEL_MODELS.map((model) => ({
    model,
    opponent: resolveOpponent({ model, thinking: options.thinking }),
    results: [],
    status: "Preparing model…"
  }))
  await Promise.allSettled(
    slots.map(async (slot) => {
      const publish = () =>
        options.onSlot({ ...slot, results: slot.results.slice() })
      publish()
      try {
        const runOptions: RunOptions = {
          opponent: slot.opponent,
          promptVersion: options.promptVersion,
          repetitions: options.repetitions,
          reasoningBudgetTokens: options.reasoningBudgetTokens,
          caseIds: options.caseIds.slice(),
          signal: options.signal,
          onResult: (result) => {
            if (!options.signal.aborted) {
              slot.results.push(result)
              publish()
            }
          },
          onProgress: (status) => {
            if (!options.signal.aborted) {
              slot.status = status
              publish()
            }
          }
        }
        const report = await (slot.model === "prompt-api"
          ? runners.prompt(runOptions)
          : runners.frame(runOptions))
        slot.report = report
        slot.results = report.results
        slot.status = `${report.partial ? "Stopped" : "Complete"}. ${report.results.length} trials retained.`
      } catch (error) {
        if (options.signal.aborted)
          slot.status = "Stopped. Completed trials retained."
        else {
          slot.error = error instanceof Error ? error.message : String(error)
          slot.status = "Failed. Completed trials retained."
        }
      }
      publish()
    })
  )
  return {
    schemaVersion: 1,
    mode: "mac-parallel",
    timingComparable: false,
    timingConditions:
      "Concurrent model and GPU work; elapsed times are diagnostic, not comparable latency benchmarks.",
    promptVersion: options.promptVersion ?? SHARED_PROMPT_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    partial:
      options.signal.aborted ||
      slots.some((slot) => !slot.report || slot.report.partial),
    reports: slots
  }
}
