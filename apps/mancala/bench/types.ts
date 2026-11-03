import type { UsageInfo } from "@tanstack/ai"
import type { Board, Game } from "../src/lib/mancala.ts"
import type { OpponentSettings } from "../src/lib/opponents.ts"
import type { PromptInput } from "../src/lib/shared-prompt.ts"

export type Objective =
  "win-now" | "best-complete-turn" | "best-reply-margin" | "diagnostic"
export type BenchmarkCase = {
  id: string
  label: string
  description: string
  category:
    "bonus turn" | "capture" | "defense" | "endgame" | "sowing" | "opening"
  partition: "calibration" | "holdout"
  objective: Objective
  board: Board
  expectedPits: number[] | null
}
export type BenchmarkResult = {
  trial: number
  repetition: number
  caseId: string
  label: string
  objective: Objective
  partition: BenchmarkCase["partition"]
  position: Game
  order: number[]
  expectedPits: number[] | null
  pit?: number
  legal: boolean
  passed: boolean | null
  inference: boolean
  seconds: number
  input?: PromptInput
  rawAnswer?: string
  reasoning: string
  usage?: UsageInfo
  error?: string
}
export type BenchmarkReport = {
  schemaVersion: 1
  suiteVersion: string
  promptVersion: string
  revision: string
  startedAt: string
  finishedAt: string
  partial: boolean
  config: {
    opponent: OpponentSettings
    reasoningMode: "off" | "native" | "emulated-working-notes"
    repetitions: number
    reasoningBudgetTokens: number
    caseIds: string[]
    orderPolicy: "paired-rotation-v1"
    sampling: "model defaults"
    promptCache: "long"
    maxOutputTokens: number | null
    userAgent: string
  }
  results: BenchmarkResult[]
  summary: {
    total: number
    inferred: number
    legal: number
    scored: number
    passed: number
    firstOption: number
    medianSeconds: number | null
  }
}
