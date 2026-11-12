import type { UsageInfo } from "@tanstack/ai"
import type { OpponentModel } from "../src/lib/opponents.ts"
export type ReasoningMode = "off" | "native" | "emulated-working-notes"

export type OutcomeAssessment = {
  verdict: "acceptable" | "mistake" | "uncertain" | "ungraded"
  basis: "rules" | "engine" | "objective" | "runtime"
  reason: string
}
export type EngineReview = {
  depth: number
  nodes: number
  sourceRun: string
  game: number
  ply: number
  grades: {
    moveId: string
    scoreType: "cp" | "mate"
    score: number
    depth: number
    nodes: number
    bound: boolean
    pv: string[]
  }[]
}
export type BenchmarkCase = {
  id: string
  label: string
  description: string
  fen: string
  history?: string[]
  humanColor?: "white" | "black"
  expectedMoveIds: string[] | null
  engineReview?: EngineReview
  orders: string[][]
  condition?: string
  suite?: "core" | "context"
  partition?: "calibration" | "holdout"
  signalMoveIds?: string[]
  signalDescription?: string
}
export type BenchmarkResult = {
  trial: number
  repetition: number
  caseId: string
  label: string
  fen: string
  objective: string
  expectedMoveIds: string[] | null
  partition: "calibration" | "holdout"
  threadId?: string
  rawAnswer?: string
  moveId?: string
  legal: boolean
  passed: boolean | null
  /** Independent outcome review; an unmet local objective is not automatically a mistake. */
  assessment?: OutcomeAssessment
  signal: boolean | null
  index: number
  total: number
  seconds: number
  choices: { id: string; notation?: string; label?: string; outcome: string }[]
  prompt?: string
  systemPrompt?: string
  thinkingChars: number
  reasoningText: string
  usage?: UsageInfo
  error?: string
  condition?: string
}
export type BenchmarkReport = {
  schemaVersion: 4
  choiceIndexBase: 0
  runId: string
  startedAt: string
  finishedAt: string
  revision: string
  partial: boolean
  config: {
    model: OpponentModel
    runtimeModel?: { id: string; name: string; browser: string | null }
    thinking: boolean
    requestedThinking: boolean
    reasoningSupported: boolean
    reasoningMode: ReasoningMode
    /** null means no explicit thinking-token cap. */
    reasoningBudgetTokens: 512 | 1024 | null
    maxOutputTokens: 8192 | null
    sampling: "model defaults" | "temperature override"
    webglTemperature?: number
    promptCache?: "default" | "none"
    timingComparable?: boolean
    timingConditions?: string
    repetitions: number
    caseIds: string[]
    suiteVersion: string
    outputContract: string
    promptVersion: string
    orderPolicy: string
    movePresentation?: "game" | "new-games" | "stress"
    sessionPolicy?: string
    /** Startup retries before a runtime received any benchmark command. */
    runtimeRestarts?: number
    moveOrderSeed?: string
  }
  results: BenchmarkResult[]
  summary: {
    total: number
    legal: number
    passed: number
    scored: number
    firstOption: number
    medianSeconds: number | null
    outcomes?: Record<OutcomeAssessment["verdict"], number>
  }
}
