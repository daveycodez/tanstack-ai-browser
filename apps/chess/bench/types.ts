import type { OpponentModel } from "../src/lib/opponents.ts"

export type BenchmarkCase = {
  id: string
  label: string
  description: string
  fen: string
  history?: string[]
  expectedMoveIds: string[] | null
  orders: string[][]
  condition?: string
}
export type BenchmarkResult = {
  trial: number
  repetition: number
  caseId: string
  label: string
  fen: string
  rawAnswer?: string
  moveId?: string
  legal: boolean
  passed: boolean | null
  /** Zero-based selected choice position; -1 if invalid. */
  index: number
  total: number
  seconds: number
  choices: { id: string; outcome: string }[]
  prompt?: string
  thinkingChars: number
  error?: string
  condition?: string
}
export type BenchmarkReport = {
  schemaVersion: 1
  choiceIndexBase: 0
  runId: string
  startedAt: string
  finishedAt: string
  revision: string
  partial: boolean
  config: {
    model: OpponentModel
    thinking: boolean
    queenValue: number
    repetitions: number
    caseIds: string[]
    reasoningBudgetTokens: 1024
    maxOutputTokens: 8192
    sampling: "model defaults"
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
