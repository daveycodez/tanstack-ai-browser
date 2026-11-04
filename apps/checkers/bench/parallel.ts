import type { OpponentModel } from "../src/lib/opponents.ts"
import type { BenchmarkReport, BenchmarkResult, PromptVersion } from "./types.ts"

export const canRunParallelBench = (platform: string, touchPoints: number) => /^Mac/.test(platform) && touchPoints === 0
export type ParallelJob = {
  id: string; model: OpponentModel; humanColor: "both"; caseIds: string[]
  state: "waiting" | "running" | "complete" | "stopped" | "error"
  message: string; results: BenchmarkResult[]; report?: BenchmarkReport; error?: string
}
export type ParallelReport = {
  schemaVersion: 1; runId: string; startedAt: string; finishedAt: string; partial: boolean
  promptVersion: PromptVersion; workersPerModel: number; jobs: ParallelJob[]
}
export function planParallelJobs(models: readonly OpponentModel[], caseIds: readonly string[], workersPerModel: number, runId: string): ParallelJob[] {
  if (!models.length || new Set(models).size !== models.length || !caseIds.length || new Set(caseIds).size !== caseIds.length) throw new Error("Choose unique models and positions.")
  if (!Number.isSafeInteger(workersPerModel) || workersPerModel < 1 || workersPerModel > caseIds.length) throw new RangeError("Workers must be between one and the number of positions.")
  const jobs: ParallelJob[] = []
  for (const model of models) for (let worker = 0; worker < workersPerModel; worker++) {
    jobs.push({ id: `${runId}-${jobs.length}`, model, humanColor: "both", caseIds: caseIds.filter((_, index) => index % workersPerModel === worker), state: "waiting", message: "Waiting to start…", results: [] })
  }
  return jobs
}
export function parallelReportData(report: ParallelReport) {
  return { ...report, jobs: report.jobs.map(({ results, report: completed, ...job }) => ({ ...job, ...(completed ? { report: completed } : { results }) })) }
}
