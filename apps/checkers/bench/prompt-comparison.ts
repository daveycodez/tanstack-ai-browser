import { runBenchmark } from "./runner.ts"
import { CASES } from "./cases.ts"
import { chooseAiMove } from "../src/lib/ai.ts"
import { applyMove } from "../src/lib/checkers.ts"
import { cacheReplayPositions } from "./cache-replay-positions.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import type { PromptVersion } from "../src/lib/shared-prompt.ts"
import type { UsageInfo } from "@tanstack/ai"

export const COMPARISON_VERSIONS = ["shared-v18", "shared-v19"] as const
export const comparisonPlans = () => [
  { version: COMPARISON_VERSIONS[0], parity: 0 },
  { version: COMPARISON_VERSIONS[1], parity: 0 },
  { version: COMPARISON_VERSIONS[1], parity: 1 },
  { version: COMPARISON_VERSIONS[0], parity: 1 }
]

/** Counterbalanced quality runs. Identical cases, expectations and seeded action orders. */
export async function comparePromptQuality(model: OpponentModel, signal: AbortSignal, emit: (event: unknown) => void) {
  for (const plan of comparisonPlans()) {
    signal.throwIfAborted()
    const report = await runBenchmark({ model, thinking: false, repetitions: 2, promptVersion: plan.version,
      caseIds: CASES.filter((_, index) => index % 2 === plan.parity).map(testCase => testCase.id),
      signal, isolationKey: `prompt-comparison-${model}`, orderPolicy: "paired", humanColor: "white",
      onProgress: label => emit({ type: "progress", model, ...plan, label }),
      onResult: result => emit({ type: "trial", model, ...plan, result })
    })
    emit({ type: "report", model, ...plan, report })
  }
}

/** Serial warm ABBA replay; changed positions and exact retries remain separate. */
export async function comparePromptTiming(signal: AbortSignal, emit: (event: unknown) => void) {
  const model = "LiquidAI/LFM3-1.7B-GGUF" as const
  const { positions } = cacheReplayPositions()
  async function execute(version: PromptVersion, sample: number, warmup: boolean, block: number, attempt: number) {
    signal.throwIfAborted()
    const game = structuredClone(positions[sample])
    game.opponent = { model, thinking: false }
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    let usage: UsageInfo | undefined
    const start = performance.now()
    try {
      const moveId = await chooseAiMove(game, controller, phase => emit({ type: "progress", model, version, label: `Timing ${warmup ? "warmup" : block}: ${sample + 1}/7 ${phase}` }), undefined,
        { promptVersion: version, onUsage: value => { usage = value } })
      applyMove(game, moveId)
      emit({ type: "timing", model, version, block, sample, warmup, kind: attempt ? "exact-repeat" : sample ? "changed-turn" : "first-turn", totalMs: performance.now() - start, usage, moveId })
    } finally { signal.removeEventListener("abort", abort) }
  }
  for (const version of COMPARISON_VERSIONS) for (let sample = 0; sample < positions.length; sample++) await execute(version, sample, true, -1, 0)
  for (const [block, version] of [COMPARISON_VERSIONS[0], COMPARISON_VERSIONS[1], COMPARISON_VERSIONS[1], COMPARISON_VERSIONS[0]].entries()) {
    await execute(version, 0, true, block, 0)
    for (let sample = 0; sample < positions.length; sample++) for (const attempt of [0, 1]) await execute(version, sample, false, block, attempt)
  }
}
