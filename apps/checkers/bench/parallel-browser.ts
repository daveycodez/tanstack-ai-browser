import { canRunParallelBench, planParallelJobs } from "./parallel.ts"
import type { ParallelJob, ParallelReport } from "./parallel.ts"
import { runBenchmark } from "./runner.ts"
import { runBenchmarkInFrame } from "./run-in-frame.ts"
import type { OpponentModel } from "../src/lib/opponents.ts"
import type { PromptVersion } from "./types.ts"

/** Chess's working model-level parallelism: native APIs stay in the parent. */
export async function runParallelSuite(options: {
  models: OpponentModel[]; caseIds: string[]; workersPerModel: number; promptVersion: PromptVersion
  signal: AbortSignal; onUpdate: (report: ParallelReport) => void
}): Promise<ParallelReport> {
  if (!canRunParallelBench(navigator.platform, navigator.maxTouchPoints)) throw new Error("Parallel suites are available on desktop Mac only.")
  options.signal.throwIfAborted()
  const runId = crypto.randomUUID()
  const report: ParallelReport = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), finishedAt: "", partial: false, promptVersion: options.promptVersion, workersPerModel: options.workersPerModel, jobs: planParallelJobs(options.models, options.caseIds, options.workersPerModel, runId) }
  const publish = () => options.onUpdate({ ...report, jobs: [...report.jobs] })
  const execute = async (job: ParallelJob) => {
    if (options.signal.aborted) { job.state = "stopped"; return }
    job.state = "running"; job.message = "Preparing model…"; publish()
    try {
      const settings = { model: job.model, humanColor: job.humanColor, caseIds: job.caseIds,
        thinking: false, repetitions: 1, promptVersion: options.promptVersion, orderPolicy: "production" as const,
        isolationKey: job.id, signal: options.signal,
        onProgress: (message: string) => { if (!options.signal.aborted) { job.message = message; publish() } },
        onResult: (result: Parameters<Parameters<typeof runBenchmark>[0]["onResult"]>[0]) => { if (!options.signal.aborted) { job.results.push(result); publish() } }
      }
      job.report = await (job.model === "prompt-api" || job.model === "apple-foundationmodel" ? runBenchmark(settings) : runBenchmarkInFrame(settings))
      job.results = job.report.results
      job.state = job.report.partial ? "stopped" : "complete"; job.message = job.report.partial ? "Stopped." : "Complete."
    } catch (error) {
      job.state = options.signal.aborted ? "stopped" : "error"
      job.error = options.signal.aborted ? undefined : error instanceof Error ? error.message : String(error)
      job.message = job.error ?? "Stopped; completed trials retained."
    }
    publish()
  }
  publish()
  await Promise.allSettled(report.jobs.map(execute))
  if (options.signal.aborted) for (const job of report.jobs) if (job.state === "waiting") { job.state = "stopped"; job.message = "Stopped." }
  report.finishedAt = new Date().toISOString()
  report.partial = options.signal.aborted || report.jobs.some(job => job.state !== "complete")
  publish()
  return report
}
