import type { UsageInfo } from "@tanstack/ai"
import type { Game, Side } from "../src/lib/checkers.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import type { PromptVersion } from "../src/lib/shared-prompt.ts"

export type Objective = "win-now" | "avoid-immediate-loss" | "best-safe-exchange" | "avoid-losing-exchange" | "best-runner-defense" | "minimize-checked-loss" | "safe-promotion" | "prevent-promotion" | "force-win-next-turn" | "force-next-capture" | "avoid-draw-ahead" | "take-draw-behind" | "diagnostic"
export type BenchmarkCase = {
  id: string
  label: string
  description: string
  objective: Objective
  partition: "calibration" | "holdout"
  setup?: { black: string[]; red: string[]; turn?: Side; quietMoves?: number }
  history?: string[]
  expectedMoveIds: string[] | null
  signalMoveIds?: string[]
  signalDescription?: string
}
export type { PromptVersion } from "../src/lib/shared-prompt.ts"
export type BenchmarkResult = {
  trial: number
  repetition: number
  caseId: string
  label: string
  objective: string
  partition: "calibration" | "holdout"
  expectedMoveIds: string[] | null
  position: Game
  moveId?: string
  rawAnswer?: string
  legal: boolean
  passed: boolean | null
  signal: boolean | null
  inference: boolean
  index: number
  seconds: number
  choices: { id: string; label: string; outcome: string }[]
  prompt?: string
  systemPrompt?: string
  reasoningText: string
  usage?: UsageInfo
  error?: string
}
export type BenchmarkReport = {
  schemaVersion: 1
  runId: string
  startedAt: string
  finishedAt: string
  revision: string
  partial: boolean
  config: {
    model: OpponentModel
    runtimeModel?: { id: string; name: string; browser: string | null }
    thinking: boolean
    reasoningMode: "off" | "native" | "emulated-working-notes"
    reasoningBudgetTokens: number
    maxOutputTokens: 8192 | null
    sampling: "model defaults"
    promptCache?: "long"
    repetitions: number
    caseIds: string[]
    suiteVersion: string
    promptVersion: PromptVersion
    outcomeVersion?: string
    orderPolicy: string
    outputContract: string
  }
  results: BenchmarkResult[]
  summary: { total: number; inferred: number; legal: number; scored: number; passed: number; firstOption: number; medianSeconds: number | null }
}


export type CacheComparisonModel = "LiquidAI/LFM3-1.7B-GGUF" | "prompt-api"
export type CacheMetrics = { inputTokens: number | null; cachedInputTokens: number | null; prefillMs: number | null; firstTokenMs: number | null; totalMs: number }
export type CacheReplayTrial = {
  trial: number; sample: number; ply: number; kind: "first-turn" | "changed-turn" | "exact-repeat"
  promptVersion: PromptVersion; sessionId: string; position: Game; seconds: number; legal: boolean
  moveId?: string; rawAnswer?: string; prompt?: string; systemPrompt?: string
  choices: BenchmarkResult["choices"]; usage?: UsageInfo; metrics: CacheMetrics; error?: string
}
export type CacheReplayReport = {
  promptVersion: PromptVersion; orderPolicy: string; sessionId: string; selectedPlies: number[]; skippedForcedPlies: number[]
  trials: CacheReplayTrial[]; partial: boolean
}
export type ComparisonQualityPhase = {
  id: string; label: string; totalTrials: number; results?: BenchmarkResult[]; report?: BenchmarkReport
}
export type CacheComparisonReport = {
  schemaVersion: 1; runId: string; startedAt: string; finishedAt: string; revision: string; partial: boolean; phase: string
  config: { model: CacheComparisonModel; runtimeModel?: { id: string; name: string; browser: string | null }; before: PromptVersion; after: PromptVersion; reasoning: "off"; reasoningBudgetTokens: 512; maxOutputTokens: 8192 | null; sampling: "model defaults"; promptCache: "long"; suiteVersion: string; caseIds: string[]; quality: boolean; cache?: boolean; qualityRepetitions: 0 | 1; includeProductionOrder: boolean; sessionId: string; selectedPlies: number[]; skippedForcedPlies: number[]; notes: string[] }
  quality: ComparisonQualityPhase[]; cache: CacheReplayReport[]
}
