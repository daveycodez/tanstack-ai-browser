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
  suite?: "core" | "context"
  signalMoveIds?: string[]
  signalDescription?: string
}
export type BenchmarkResult = {
  trial: number
  promptStyleId: string
  promptStyleLabel: string
  variantId: string
  variantLabel: string
  signal: boolean | null
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
  schemaVersion: 3
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
    queenValue: number
    repetitions: number
    caseIds: string[]
    reasoningBudgetTokens: 1024
    maxOutputTokens: 8192
    sampling: "model defaults" | "profile overrides"
    orderPolicy: string
    promptStyleId: string
    promptStyles: { id: string; label: string; repetitionPenalty?: number }[]
    contextVariantId: string
    contextVariants: {
      id: string
      features: {
        relationships: boolean
        support: boolean
        mobility: boolean
        castling: boolean
      }
    }[]
  }
  promptComparisons?: {
    referenceStyleId: string
    promptStyleId: string
    pairedTactics: number
    improved: number
    regressed: number
    unchanged: number
    legalityRegressions: number
  }[]
  comparisons?: {
    variantId: string
    pairedTactics: number
    improved: number
    regressed: number
    unchanged: number
    legalityRegressions: number
    medianPromptChars: number | null
    medianSeconds: number | null
  }[]
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
