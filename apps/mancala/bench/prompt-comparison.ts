import { runBenchmark } from "./runner.ts"
import { CASES, gameForCase } from "./cases.ts"
import { applyMove, legalMoves } from "../src/lib/mancala.ts"
import { chooseAiMove } from "../src/lib/ai.ts"
import { PREVIOUS_PROMPT_VERSION, CONCISE_PROMPT_VERSION } from "../src/lib/shared-prompt.ts"
import type { PromptVersion } from "../src/lib/shared-prompt.ts"
import type { OpponentSettings } from "../src/lib/opponents.ts"
import type { UsageInfo } from "@tanstack/ai"

const versions = [PREVIOUS_PROMPT_VERSION, CONCISE_PROMPT_VERSION] as const
export async function comparePromptQuality(model: OpponentSettings["model"], signal: AbortSignal, emit: (event: unknown) => void) {
  for (const [version, parity] of [[versions[0], 0], [versions[1], 0], [versions[1], 1], [versions[0], 1]] as const) {
    signal.throwIfAborted()
    const report = await runBenchmark({ opponent: { model, thinking: false }, repetitions: 2, promptVersion: version, reasoningBudgetTokens: 512,
      caseIds: CASES.filter((_, index) => index % 2 === parity).map(fixture => fixture.id), signal,
      onResult: result => emit({ type: "trial", model, version, parity, result }),
      onProgress: label => emit({ type: "progress", model, version, label }) })
    emit({ type: "report", model, version, parity, report })
  }
}
export async function comparePromptTiming(signal: AbortSignal, emit: (event: unknown) => void) {
  const model = "LiquidAI/LFM3-1.7B-GGUF" as const
  // Predetermined suite snapshots, not a continuous or model-selected game.
  const positions = CASES.map(fixture => gameForCase(fixture)).filter(game => legalMoves(game.board, "ai").length > 1).slice(0, 7)
  async function execute(version: PromptVersion, sample: number, warmup: boolean, block: number, attempt: number) {
    signal.throwIfAborted()
    const game = structuredClone(positions[sample]); game.sessionId = "mancala-prompt-compaction-replay"; game.opponent = { model, thinking: false }
    const controller = new AbortController(); const abort = () => controller.abort(signal.reason); signal.addEventListener("abort", abort, { once: true })
    let usage: UsageInfo | undefined; const start = performance.now()
    try {
      const pit = await chooseAiMove(game, controller, phase => emit({ type: "progress", model, version, label: `Timing ${warmup ? "warmup" : block}: ${sample + 1}/${positions.length} ${phase}` }), undefined,
        { promptVersion: version, onUsage: value => { usage = value } })
      applyMove(game, pit)
      emit({ type: "timing", model, version, block, sample, warmup, kind: attempt ? "exact-repeat" : sample ? "changed-position" : "first-position", totalMs: performance.now() - start, usage, pit })
    } finally { signal.removeEventListener("abort", abort) }
  }
  for (const version of versions) for (let sample = 0; sample < positions.length; sample++) await execute(version, sample, true, -1, 0)
  for (const [block, version] of [versions[0], versions[1], versions[1], versions[0]].entries()) {
    await execute(version, 0, true, block, 0)
    for (let sample = 0; sample < positions.length; sample++) for (const attempt of [0, 1]) await execute(version, sample, false, block, attempt)
  }
}
