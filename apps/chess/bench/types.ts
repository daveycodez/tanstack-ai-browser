import type { UsageInfo } from "@tanstack/ai"
import type { OpponentModel } from "../src/lib/opponents.ts"
export type ReasoningMode = "off" | "native" | "emulated-working-notes"

export type BenchmarkCase = {
  id: string
  label: string
  description: string
  fen: string
  history?: string[]
  expectedMoveIds: string[] | null
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
  rawAnswer?: string
  moveId?: string
  legal: boolean
  passed: boolean | null
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
    reasoningBudgetTokens: 512 | 1024
    maxOutputTokens: 8192 | null
    sampling: "model defaults"
    repetitions: number
    caseIds: string[]
    suiteVersion: string
    outputContract: string
    promptVersion: string
    orderPolicy: string
  }
  results: BenchmarkResult[]
  summary: {
    total: number
    legal: number
    passed: number
    scored: number
    firstOption: number
    medianSeconds: number | null
  }
}
