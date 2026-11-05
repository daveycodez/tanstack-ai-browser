import { useEffect, useRef, useState } from "react"
import { CASES } from "../../bench/cases"
import { parallelReportData } from "../../bench/parallel"
import { runParallelSuite } from "../../bench/parallel-browser"
import type { ParallelReport } from "../../bench/parallel"
import type { PromptVersion } from "../../bench/types"
import type { OpponentModel, OpponentOption } from "../lib/opponents"

export function ParallelBenchmark({ options, promptVersion, disabled, onRunningChange }: { options: OpponentOption[]; promptVersion: PromptVersion; disabled: boolean; onRunningChange: (running: boolean) => void }) {
  const defaults = options.filter(option => option.thinking !== "required" && (option.id.endsWith("-GGUF") || option.id === "prompt-api" || option.id === "apple-foundationmodel"))
  const [selected, setSelected] = useState<OpponentModel[]>()
  const models = (selected ?? defaults.map(option => option.id)).filter(id => options.some(option => option.id === id))
  const [workers, setWorkers] = useState(1)
  const [report, setReport] = useState<ParallelReport>()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const [showJson, setShowJson] = useState(false)
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])
  async function start() {
    if (controller.current || disabled || !models.length) return
    const active = new AbortController(); controller.current = active
    setError(undefined); setShowJson(false); setRunning(true); onRunningChange(true)
    try {
      await runParallelSuite({ models, caseIds: CASES.map(testCase => testCase.id), workersPerModel: workers, promptVersion, signal: active.signal,
        onUpdate: report => { if (controller.current === active) setReport(report) } })
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { if (controller.current === active) controller.current = undefined; setRunning(false); onRunningChange(false) }
  }
  const groups = [...new Set(report?.jobs.map(job => job.model) ?? [])].flatMap(model => (["white", "black"] as const).map(color => {
    const jobs = (report?.jobs ?? []).filter(job => job.model === model)
    const results = jobs.flatMap(job => job.results).filter(result => result.position.humanColor === color)
    const scored = results.filter(result => result.inference && result.passed !== null)
    const activeWorkers = jobs.filter(job => job.state === "running" && (job.message.includes(`human ${color}`) || (job.results.at(-1)?.position.humanColor ?? "white") === color)).length
    const errors = results.filter(result => result.error).length
    const state = results.length === CASES.length ? errors ? `${errors} errors` : "Complete" : jobs.find(job => job.error)?.error ?? (jobs.some(job => job.state === "stopped") ? "Stopped" : activeWorkers ? `${activeWorkers} active workers` : "Waiting")
    return { key: `${model}:${color}`, jobs, model, color, total: results.length, legal: results.filter(result => result.legal).length, passed: scored.filter(result => result.passed).length, scored: scored.length, errors, state }
  }))
  return <section className="bench-controls bench-parallel" aria-label="Mac parallel suite">
    <h2>Mac parallel suite</h2>
    <p>All selected models in this tab; each runs both colors in sequence. Native models stay in the main window and WebGL uses isolated runtimes. Timings include contention.</p>
    <fieldset disabled={disabled || running}>
      <legend>Models · thinking off</legend>
      <div className="bench-parallel-models">{options.filter(option => option.thinking !== "required").map(option => <label key={option.id}><input type="checkbox" checked={models.includes(option.id)} onChange={event => setSelected(event.currentTarget.checked ? [...models, option.id] : models.filter(id => id !== option.id))} />{option.label}</label>)}</div>
      <label>Workers per model <input aria-label="Workers per model" type="number" min={1} max={CASES.length} value={workers} onChange={event => setWorkers(Number(event.currentTarget.value))} /></label>
    </fieldset>
    <div className="bench-actions"><button type="button" disabled={disabled || running || !models.length} onClick={() => { void start() }}>Run parallel suite</button><button type="button" disabled={!running} onClick={() => controller.current?.abort()}>Stop parallel suite</button><button type="button" disabled={!report || running} onClick={() => setShowJson(previous => !previous)}>Parallel report JSON</button></div>
    <p role="status">{running ? `Running ${report?.jobs.filter(job => job.state === "running").length ?? 0} workers.` : report ? report.partial ? report.jobs.some(job => job.state === "error") ? "Finished with worker errors; completed trials retained." : "Stopped; completed trials retained." : "Parallel suite complete." : `${models.length} models × 2 colors × ${CASES.length} positions = ${models.length * 2 * CASES.length} trials; ${models.length * workers} concurrent workers.`}</p>
    {error && <p role="alert">{error}</p>}
    {!!groups.length && <div className="bench-parallel-table"><table aria-label="Parallel model results"><thead><tr><th>Model</th><th>Human color</th><th>Complete</th><th>Passed</th><th>Legal</th><th>Status</th></tr></thead><tbody>{groups.map(group => <tr key={group.key}><td>{options.find(option => option.id === group.model)?.label ?? group.model}</td><td>{group.color}</td><td>{group.total}/{CASES.length}</td><td>{group.passed}/{group.scored}</td><td>{group.legal}/{group.total}</td><td>{group.state}</td></tr>)}</tbody></table></div>}
    {showJson && report && <pre id="parallel-benchmark-json">{JSON.stringify(parallelReportData(report), null, 2)}</pre>}
  </section>
}
