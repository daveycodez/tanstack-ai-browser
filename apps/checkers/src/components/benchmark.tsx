import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { FormEvent, ReactNode } from "react"
import { CASES, SUITE_VERSION } from "../../bench/cases"
import { runBenchmark } from "../../bench/runner"
import type { BenchmarkReport, BenchmarkResult, PromptVersion } from "../../bench/types"
import { DEFAULT_OPPONENT, opponentOption, WEBGL_OPPONENTS } from "../lib/opponents"
import type { OpponentModel } from "../lib/opponents"
import { SHARED_PROMPT_VERSION } from "../lib/shared-prompt"
import { usePromptApiAvailable } from "../lib/use-prompt-api"

const subscribeHydration = () => () => undefined

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null
}
const time = (seconds: number | null) => seconds === null ? "—" : `${seconds.toFixed(2)}s`
const grade = (result: BenchmarkResult) => !result.inference ? "Forced move" : result.error ? "Error" : result.passed === null ? "Diagnostic" : result.passed ? "Pass" : "Miss"
const json = (value: unknown) => JSON.stringify(value, null, 2)

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return <details className="bench-detail"><summary>{title}</summary><pre>{children}</pre></details>
}

function Trial({ result }: { result: BenchmarkResult }) {
  const board = result.position.board
  const boardText = ["    a b c d e f g h", ...Array.from({ length: 8 }, (_, row) => `${8 - row}   ${board.slice(row * 8, row * 8 + 8).map(piece => !piece ? "." : piece.side === "ai" ? piece.king ? "B" : "b" : piece.king ? "R" : "r").join(" ")}`), "", "Black b/B; Red r/R. Uppercase = king."].join("\n")
  return <details className={`bench-trial${result.passed === false || result.error ? " bench-trial-miss" : ""}`}>
    <summary>
      <span className="bench-trial-number">{result.trial}</span>
      <span className="bench-trial-name">{result.label}<small>Repetition {result.repetition} · {result.partition}</small></span>
      <span className="bench-trial-move">{result.moveId ?? "No move"}</span>
      <span className={`bench-grade${result.passed === true ? " bench-grade-pass" : result.passed === false || result.error ? " bench-grade-miss" : ""}`}>{grade(result)}</span>
      <span className="bench-trial-time">{time(result.seconds)}</span>
    </summary>
    <div className="bench-trial-body">
      <p>{result.objective}</p>
      <dl className="bench-facts">
        <div><dt>Chosen move</dt><dd>{result.moveId ?? "—"}</dd></div>
        <div><dt>Legal</dt><dd>{result.legal ? "Yes" : "No"}</dd></div>
        <div><dt>Accepted moves</dt><dd>{result.expectedMoveIds?.join(", ") ?? "Ungraded diagnostic"}</dd></div>
        <div><dt>Model inference</dt><dd>{result.inference ? "Called" : "Skipped: only one legal move"}</dd></div>
        {result.signal !== null && <div><dt>Diagnostic signal</dt><dd>{result.signal ? "Observed" : "Not observed"} · ungraded</dd></div>}
      </dl>
      {result.error && <p className="bench-error">{result.error}</p>}
      <Detail title="Position before move">{boardText}</Detail>
      <details className="bench-detail"><summary>Every legal move and its outcome</summary>
        <div className="bench-choice-list">{result.choices.map(choice => <article key={choice.id} className={choice.id === result.moveId ? "bench-choice-chosen" : undefined}><h4>{choice.label} <span>{choice.id}</span></h4><p>{choice.outcome}</p></article>)}</div>
      </details>
      <Detail title="Model answer">{result.rawAnswer ?? "No raw answer was returned."}</Detail>
      <Detail title="System prompt">{result.systemPrompt || "No system prompt."}</Detail>
      <Detail title="Full position prompt">{result.prompt ?? "No prompt was sent."}</Detail>
      <Detail title="Reasoning / working notes">{result.reasoningText || "No reasoning text was returned. The report records the configured reasoning mode."}</Detail>
      <Detail title="Usage">{result.usage ? json(result.usage) : "No usage was reported."}</Detail>
      <Detail title="Complete trial JSON">{json(result)}</Detail>
    </div>
  </details>
}

export function BenchmarkView() {
  const [model, setModel] = useState<OpponentModel>(DEFAULT_OPPONENT.model)
  const [thinking, setThinking] = useState(false)
  const [reasoningBudgetTokens, setReasoningBudgetTokens] = useState(512)
  const [repetitions, setRepetitions] = useState(2)
  const [promptVersion, setPromptVersion] = useState<PromptVersion>(SHARED_PROMPT_VERSION)
  const [position, setPosition] = useState("calibration")
  const ready = useSyncExternalStore(subscribeHydration, () => true, () => false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [report, setReport] = useState<BenchmarkReport>()
  const [runConfig, setRunConfig] = useState<Record<string, unknown>>()
  const [status, setStatus] = useState("Ready. Inference starts only when you press Run benchmark.")
  const [error, setError] = useState<string>()
  const [copyStatus, setCopyStatus] = useState("")
  const controller = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const promptApiAvailable = usePromptApiAvailable()
  const support = opponentOption(model).thinking
  const effectiveThinking = support === "required" || (support === "optional" && thinking)
  const selectedCases = useMemo(() => {
    if (position === "all") return CASES
    if (position === "reported-games") return CASES.filter(testCase => testCase.id.startsWith("reported-"))
    if (position === "reported-runners") return CASES.filter(testCase => testCase.id.startsWith("reported-runner-"))
    if (position === "reported-exchanges") return CASES.filter(testCase => testCase.id.startsWith("reported-exchange-"))
    if (position === "calibration" || position === "holdout") return CASES.filter(testCase => testCase.partition === position)
    if (position === "failed") {
      const failed = new Set(results.filter(result => result.passed === false || result.error).map(result => result.caseId))
      return CASES.filter(testCase => failed.has(testCase.id))
    }
    return CASES.filter(testCase => testCase.id === position)
  }, [position, results])
  const groups = useMemo(() => CASES.flatMap(testCase => {
    const trials = results.filter(result => result.caseId === testCase.id)
    return trials.length ? [{ testCase, trials }] : []
  }), [results])
  const scored = results.filter(result => result.inference && result.passed !== null)
  const inferred = results.filter(result => result.inference)
  const fullReport = report ?? { schemaVersion: 1, partial: true, config: runConfig ?? { suiteVersion: SUITE_VERSION }, results }
  const planned = selectedCases.length * (Number.isFinite(repetitions) ? repetitions : 0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controller.current?.abort() }
  }, [])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || controller.current || !event.currentTarget.reportValidity() || !selectedCases.length) return
    const active = new AbortController()
    controller.current = active
    const config = { model, thinking: effectiveThinking, reasoningMode: !effectiveThinking ? "off" : model === "prompt-api" ? "emulated-working-notes" : "native", reasoningBudgetTokens, repetitions, promptVersion, suiteVersion: SUITE_VERSION, caseIds: selectedCases.map(testCase => testCase.id), maxOutputTokens: model === "prompt-api" ? null : 8192, sampling: "model defaults" }
    const completed: BenchmarkResult[] = []
    setRunConfig(config)
    setResults([])
    setReport(undefined)
    setError(undefined)
    setCopyStatus("")
    setRunning(true)
    setStatus("Preparing model and positions…")
    try {
      const output = await runBenchmark({ model, thinking: effectiveThinking, reasoningBudgetTokens, repetitions, promptVersion, caseIds: config.caseIds, signal: active.signal,
        onResult(result) { if (controller.current !== active) return; completed.push(result); if (mounted.current) setResults([...completed]) },
        onProgress(label) { if (mounted.current && controller.current === active && !active.signal.aborted) setStatus(label) }
      })
      if (!mounted.current) return
      setReport(output)
      setStatus(`${output.partial || active.signal.aborted ? "Stopped" : "Complete"}. ${output.results.length} completed trials are printed below.`)
    } catch (failure) {
      if (!mounted.current) return
      if (active.signal.aborted) setStatus(`Stopped. ${completed.length} completed trials are preserved below.`)
      else { setError(failure instanceof Error ? failure.message : String(failure)); setStatus("The run ended with an error. Completed trials are preserved below.") }
    } finally {
      if (controller.current === active) controller.current = undefined
      if (mounted.current) setRunning(false)
    }
  }

  async function copyReport() {
    try { await navigator.clipboard.writeText(json(fullReport)); setCopyStatus("Report copied.") }
    catch { setCopyStatus("Copy is unavailable. Select the report text below to copy it.") }
  }

  return <main className="checkers-bench">
    <header className="bench-header">
      <div><Link className="bench-back" to="/">Checkers</Link><h1>AI move benchmark</h1><p>One shared prompt, the same legal choices and board facts. Compare local models on clear, bounded checkers decisions.</p></div>
      <span className="bench-manual">Manual benchmark</span>
    </header>
    <form className="bench-controls" onSubmit={event => { void start(event) }}>
      <fieldset disabled={running || !ready}>
        <legend>Run settings</legend>
        <div className="bench-control-grid">
          <label>Opponent model<select aria-label="Opponent model" value={model} onChange={event => { setModel(event.currentTarget.value as OpponentModel); setThinking(false) }}>
            {promptApiAvailable && <option value="prompt-api">{opponentOption("prompt-api").label}</option>}
            {WEBGL_OPPONENTS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label>
          <label>Prompt version<select aria-label="Prompt version" value={promptVersion} onChange={event => setPromptVersion(event.currentTarget.value as PromptVersion)}><option value={SHARED_PROMPT_VERSION}>Shared outcomes</option><option value="baseline-v1">Original baseline</option></select></label>
          <label>Repetitions<input aria-label="Repetitions" type="number" min={1} max={20} step={1} required value={repetitions} onChange={event => setRepetitions(Number(event.currentTarget.value))} /></label>
          <label>Positions<select aria-label="Positions" value={position} onChange={event => setPosition(event.currentTarget.value)}>
            <option value="calibration">Calibration positions</option><option value="holdout">Held-out positions</option><option value="all">All positions</option><option value="reported-games">All reported game positions</option><option value="reported-runners">Reported runner defenses</option><option value="reported-exchanges">Reported game exchanges</option><option value="failed">Failures from the previous run</option>
            <optgroup label="Single position">{CASES.map(testCase => <option key={testCase.id} value={testCase.id}>{testCase.label}</option>)}</optgroup>
          </select></label>
          <label className="bench-thinking"><span>{model === "prompt-api" ? "Working notes" : "Thinking"}</span><span className="bench-check-row"><input aria-label="Thinking" type="checkbox" checked={effectiveThinking} disabled={running || support !== "optional"} onChange={event => setThinking(event.currentTarget.checked)} /><span>{support === "none" ? "Not supported" : support === "required" ? "Required by model" : effectiveThinking ? "On" : "Off"}</span></span></label>
          <label>Reasoning budget<input aria-label="Reasoning budget" type="number" min={0} step={1} required value={reasoningBudgetTokens} disabled={running || !effectiveThinking} onChange={event => setReasoningBudgetTokens(Number(event.currentTarget.value))} /></label>
        </div>
      </fieldset>
      <div className="bench-run-row"><button className="bench-button bench-button-primary" type="submit" disabled={running || !ready || !selectedCases.length}>Run benchmark</button><button className="bench-button" type="button" disabled={!running} onClick={() => { controller.current?.abort(); setStatus("Stopping the active trial…") }}>Stop</button><span>{running ? "Running selected configuration" : `${selectedCases.length} positions × ${repetitions || 0} repetitions = ${planned} trials`}</span></div>
      <p className="bench-note">Runs through the game’s AI path. No saved-game changes, hosted API, automatic retry, or result download. Forced moves are reported separately from model decisions. Sampling uses model defaults.</p>
      <p className="bench-note">Thinking is native on supported WebGL models. Prompt API working notes are an explicit, emulated extra pass. Keep them off for the baseline comparison.</p>
    </form>
    <div className="bench-status" role="status" aria-live="polite">{status}</div>
    {error && <p className="bench-error" role="alert">{error}</p>}
    <section className="bench-summary" aria-label="Run summary">
      <div><span>Objective passes</span><strong>{scored.filter(result => result.passed).length} / {scored.length}</strong></div>
      <div><span>Legal replies</span><strong>{results.filter(result => result.legal).length} / {results.length}</strong></div>
      <div><span>Model decisions</span><strong>{inferred.length}<small> · {results.length - inferred.length} forced</small></strong></div>
      <div><span>Median decision</span><strong>{time(median(inferred.map(result => result.seconds)))}</strong></div>
    </section>
    <section className="bench-section" aria-labelledby="bench-positions-heading"><div className="bench-section-heading"><h2 id="bench-positions-heading">Position outcomes</h2><span>{SUITE_VERSION}</span></div>
      {groups.length ? <div className="bench-table-wrap"><table><thead><tr><th>Position</th><th>Objective</th><th>Passed</th><th>Legal</th><th>Median</th></tr></thead><tbody>{groups.map(({testCase,trials}) => {
        const graded = trials.filter(result => result.inference && result.passed !== null)
        return <tr key={testCase.id}><td><strong>{testCase.label}</strong><small>{testCase.partition}</small></td><td>{testCase.description}{testCase.signalDescription && <small>{testCase.signalDescription}</small>}</td><td>{graded.length ? `${graded.filter(result => result.passed).length} / ${graded.length}` : testCase.signalMoveIds ? `${trials.filter(result => result.signal).length} / ${trials.filter(result => result.signal !== null).length} signal` : "Ungraded"}</td><td>{trials.filter(result => result.legal).length} / {trials.length}</td><td>{time(median(trials.filter(result => result.inference).map(result => result.seconds)))}</td></tr>
      })}</tbody></table></div> : <p className="bench-empty">Results appear here as each trial finishes.</p>}
    </section>
    <section className="bench-section" aria-labelledby="bench-trials-heading"><div className="bench-section-heading"><h2 id="bench-trials-heading">Every trial</h2><span>{results.length} completed</span></div><p className="bench-note">Expand a trial to see every move outcome, the exact prompts, model answer, and available reasoning. A pass applies to its stated objective, not general playing strength.</p><div className="bench-trials">{results.map(result => <Trial key={`${result.caseId}:${result.repetition}:${result.trial}`} result={result} />)}</div></section>
    <section className="bench-section"><div className="bench-section-heading"><h2>Full report</h2><button className="bench-button" type="button" disabled={!results.length} onClick={() => { void copyReport() }}>Copy report</button></div><p className="bench-note" aria-live="polite">{copyStatus || "All completed trials remain available if a run is stopped."}</p><details className="bench-report" open={!!report}><summary>Report JSON</summary><pre id="benchmark-results-json">{json(fullReport)}</pre></details></section>
    <footer className="bench-footer">No model inference runs during prerendering, builds, or automated tests.</footer>
  </main>
}
