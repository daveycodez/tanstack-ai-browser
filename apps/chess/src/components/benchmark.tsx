import { useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent } from "react"
import { promptApiAvailability } from "@tanstack-ai-browser/prompt-api"
import {
  DEFAULT_OPPONENT,
  PROMPT_API_OPTION,
  WEBGL_OPPONENTS,
  opponentOption
} from "../lib/opponents"
import type { OpponentModel } from "../lib/opponents"
import { CASES } from "../../bench/cases"
import { runBenchmark } from "../../bench/runner"
import type { BenchmarkReport, BenchmarkResult } from "../../bench/types"

function seconds(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(2)} s` : "—"
}
function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return Number.NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function BenchmarkView() {
  const [model, setModel] = useState<OpponentModel>(DEFAULT_OPPONENT.model)
  const [promptAvailable, setPromptAvailable] = useState(false)
  const [fixture, setFixture] = useState("all")
  const [thinking, setThinking] = useState(false)
  const [queenValue, setQueenValue] = useState(9)
  const [repetitions, setRepetitions] = useState(2)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [report, setReport] = useState<BenchmarkReport>()
  const [partialReport, setPartialReport] = useState<Record<string, unknown>>()
  const [status, setStatus] = useState(
    "Ready. Select a model and run the full position suite."
  )
  const [error, setError] = useState<string>()
  const controller = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const support = opponentOption(model).thinking
  const effectiveThinking =
    support === "required" || (support === "optional" && thinking)
  const scored = results.filter((result) => result.passed !== null)
  const grouped = useMemo(() => {
    const groups = new Map<string, BenchmarkResult[]>()
    for (const result of results)
      groups.set(result.caseId, [...(groups.get(result.caseId) ?? []), result])
    return Array.from(groups.values())
  }, [results])

  useEffect(() => {
    mounted.current = true
    void promptApiAvailability()
      .then((availability) => {
        if (mounted.current) setPromptAvailable(availability !== "unavailable")
      })
      .catch(() => {
        /* WebGL remains available if Prompt API detection fails. */
      })
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (controller.current || !event.currentTarget.reportValidity()) return
    const active = new AbortController()
    controller.current = active
    const startedAt = new Date().toISOString()
    const config = {
      model,
      thinking: effectiveThinking,
      queenValue,
      repetitions,
      caseIds:
        fixture === "all" ? CASES.map((testCase) => testCase.id) : [fixture],
      reasoningBudgetTokens: 1024,
      maxOutputTokens: 8192,
      sampling: "model defaults"
    }
    const completedResults: BenchmarkResult[] = []
    setRunning(true)
    setResults([])
    setReport(undefined)
    setPartialReport({
      partial: true,
      choiceIndexBase: 0,
      startedAt,
      config,
      results: []
    })
    setError(undefined)
    setStatus("Preparing model and positions…")
    try {
      const completed = await runBenchmark({
        model,
        thinking: effectiveThinking,
        queenValue,
        repetitions,
        caseIds: config.caseIds,
        signal: active.signal,
        onResult: (result) => {
          completedResults.push(result)
          if (!mounted.current) return
          setResults([...completedResults])
          setPartialReport({
            partial: true,
            choiceIndexBase: 0,
            startedAt,
            config,
            results: [...completedResults]
          })
        },
        onProgress: (label) => {
          if (mounted.current) setStatus(label)
        }
      })
      if (!mounted.current) return
      setReport(completed)
      setStatus(
        active.signal.aborted
          ? `Stopped. ${completed.results.length} completed trials are printed below.`
          : `Complete. ${completed.results.length} trials finished. The full report is printed below.`
      )
    } catch (failure: unknown) {
      if (!mounted.current) return
      if (active.signal.aborted)
        setStatus(
          `Stopped. ${completedResults.length} completed trials are printed below.`
        )
      else {
        setError(failure instanceof Error ? failure.message : String(failure))
        setStatus(
          "The benchmark stopped after an error. Completed trials are printed below."
        )
      }
    } finally {
      if (controller.current === active) controller.current = undefined
      if (mounted.current) setRunning(false)
    }
  }

  return (
    <main className="benchmark-shell">
      <header className="page-header">
        <div>
          <a className="back-link" href="/">
            Chess
          </a>
          <h1>AI move benchmark</h1>
          <p>
            Run the same chess positions against an on-device model. Inspect its
            legal choice, tactical result, and exact answer.
          </p>
        </div>
        <span className="manual-badge">Manual diagnostic</span>
      </header>
      <form className="controls-panel" onSubmit={start}>
        <fieldset disabled={running}>
          <legend>Run configuration</legend>
          <div className="control-grid">
            <label className="model-control">
              Opponent model
              <select
                value={model}
                onChange={(event) =>
                  setModel(event.target.value as OpponentModel)
                }
                required
              >
                {promptAvailable && (
                  <option value="prompt-api">
                    {PROMPT_API_OPTION.label} ({PROMPT_API_OPTION.detail})
                  </option>
                )}
                {WEBGL_OPPONENTS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} ({option.detail})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Position
              <select
                value={fixture}
                onChange={(event) => setFixture(event.target.value)}
              >
                <option value="all">All positions</option>
                {CASES.map((testCase) => (
                  <option key={testCase.id} value={testCase.id}>
                    {testCase.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Repetitions
              <input
                type="number"
                min="1"
                max="20"
                step="1"
                value={Number.isNaN(repetitions) ? "" : repetitions}
                onChange={(event) => setRepetitions(event.target.valueAsNumber)}
                required
              />
            </label>
            <label>
              Queen priority value
              <input
                type="number"
                min="9"
                max="30"
                step="1"
                value={Number.isNaN(queenValue) ? "" : queenValue}
                onChange={(event) => setQueenValue(event.target.valueAsNumber)}
                required
              />
            </label>
          </div>
          <div className="configuration-notes">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={effectiveThinking}
                disabled={support !== "optional"}
                onChange={(event) => setThinking(event.target.checked)}
              />
              <span>
                Thinking
                {support === "required"
                  ? " (required by this model)"
                  : support === "none"
                    ? " (not supported)"
                    : ""}
              </span>
            </label>
            <span>
              Reasoning budget: <strong>1,024 tokens</strong>
            </span>
            <span>
              Output cap: <strong>8,192 tokens</strong>
            </span>
            <span>Standard material: P 1 · N 3 · B 3 · R 5</span>
          </div>
        </fieldset>
        <div className="run-actions">
          <button className="button primary" type="submit" disabled={running}>
            Run benchmark
          </button>
          <button
            className="button"
            type="button"
            disabled={!running}
            onClick={() => {
              controller.current?.abort()
              setStatus("Stopping after the current operation…")
            }}
          >
            Stop
          </button>
        </div>
        <p className="local-note">
          This tool runs only when you press Run. Models may download on first
          use. Results are printed in this page; your saved game is untouched.
          Queen priority is an experimental weight override for this run; the
          game’s standard queen value stays 9.
        </p>
      </form>
      <section className="run-status" aria-label="Run status">
        <span className={`status-dot${running ? " running" : ""}`} />
        <p role="status" aria-live="polite">
          {status}
        </p>
        <span className="run-count">
          {results.length} {results.length === 1 ? "trial" : "trials"}
        </span>
      </section>
      {error && (
        <p className="fatal-error" role="alert">
          {error}
        </p>
      )}
      <section className="results-section" aria-labelledby="summary-heading">
        <div className="section-heading">
          <h2 id="summary-heading">Position summary</h2>
          <p>
            {results.length
              ? `${results.filter((result) => result.legal).length}/${results.length} legal · ${scored.filter((result) => result.passed).length}/${scored.length} tactical passes`
              : "No results yet"}
          </p>
        </div>
        <div className="table-scroll">
          <table className="summary-table">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col">Tactical passes</th>
                <th scope="col">Legal choices</th>
                <th scope="col">Median time</th>
                <th scope="col">First-option choices</th>
              </tr>
            </thead>
            <tbody>
              {grouped.length ? (
                grouped.map((trials) => {
                  const evaluated = trials.filter(
                    (trial) => trial.passed !== null
                  )
                  return (
                    <tr key={trials[0].caseId}>
                      <td className="position-label">{trials[0].label}</td>
                      <td>
                        {evaluated.length
                          ? `${evaluated.filter((trial) => trial.passed).length} / ${evaluated.length}`
                          : "Diagnostic only"}
                      </td>
                      <td>
                        {trials.filter((trial) => trial.legal).length} /{" "}
                        {trials.length}
                      </td>
                      <td>
                        {seconds(median(trials.map((trial) => trial.seconds)))}
                      </td>
                      <td>
                        {trials.filter((trial) => trial.index === 0).length} /{" "}
                        {trials.length}
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr className="empty-row">
                  <td colSpan={5}>
                    Each position’s results will appear here as trials finish.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="table-note">
          A tactical pass matches the fixture’s expected move. First-option
          choices help expose an ordering bias; they are not inherently
          failures.
        </p>
      </section>
      <section className="results-section" aria-labelledby="trials-heading">
        <div className="section-heading">
          <h2 id="trials-heading">Trial ledger</h2>
          <p>Expand a trial to inspect its exact choices and model answer.</p>
        </div>
        <div className="table-scroll">
          <table className="trials-table">
            <thead>
              <tr>
                <th scope="col">Trial / position</th>
                <th scope="col">Status</th>
                <th scope="col">Selected move</th>
                <th scope="col">Choice</th>
                <th scope="col">Tactics</th>
                <th scope="col">Time</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            {results.length ? (
              results.map((result) => (
                <tbody key={result.trial}>
                  <tr>
                    <td className="position-label">
                      {result.trial}. {result.label}
                    </td>
                    <td>
                      <span
                        className={`badge ${result.error || !result.legal ? "bad" : "good"}`}
                      >
                        {result.error
                          ? "Error"
                          : result.legal
                            ? "Legal"
                            : "Invalid"}
                      </span>
                    </td>
                    <td className="move-code">{result.moveId ?? "—"}</td>
                    <td>
                      {result.index >= 0
                        ? `${result.index + 1} / ${result.total}`
                        : `— / ${result.total}`}
                    </td>
                    <td>
                      <span
                        className={`badge ${result.passed === null ? "neutral" : result.passed ? "good" : "bad"}`}
                      >
                        {result.passed === null
                          ? "Diagnostic"
                          : result.passed
                            ? "Pass"
                            : "Fail"}
                      </span>
                    </td>
                    <td className="numeric">{seconds(result.seconds)}</td>
                    <td className="error-cell">{result.error ?? "—"}</td>
                  </tr>
                  <tr className="detail-row">
                    <td colSpan={7}>
                      <details>
                        <summary>Inspect choices and raw answer</summary>
                        <div className="trial-detail">
                          {result.condition && (
                            <section>
                              <h3>Condition</h3>
                              <pre>{result.condition}</pre>
                            </section>
                          )}
                          {result.prompt && (
                            <section>
                              <h3>Exact prompt</h3>
                              <pre>{result.prompt}</pre>
                            </section>
                          )}
                          <section>
                            <h3>Exact ordered choices</h3>
                            <pre>
                              {result.choices
                                .map(
                                  (choice, index) =>
                                    `${index + 1}. ${choice.id}\n${choice.outcome}`
                                )
                                .join("\n\n") || "No choices recorded."}
                            </pre>
                          </section>
                          <section>
                            <h3>Raw model answer</h3>
                            <pre>
                              {result.rawAnswer ?? "No answer recorded."}
                            </pre>
                          </section>
                          {result.error && (
                            <section>
                              <h3>Error</h3>
                              <pre>{result.error}</pre>
                            </section>
                          )}
                        </div>
                      </details>
                    </td>
                  </tr>
                </tbody>
              ))
            ) : (
              <tbody>
                <tr className="empty-row">
                  <td colSpan={7}>No trials have run.</td>
                </tr>
              </tbody>
            )}
          </table>
        </div>
      </section>
      <section className="results-section">
        <details className="printed-report">
          <summary>Full report JSON</summary>
          <pre id="benchmark-results-json">
            {JSON.stringify(
              report ?? partialReport ?? { results: [] },
              null,
              2
            )}
          </pre>
        </details>
      </section>
      <footer className="page-footer">
        Manual diagnostic · Not part of the automated test suite · No game data
        is read or written
      </footer>
    </main>
  )
}
