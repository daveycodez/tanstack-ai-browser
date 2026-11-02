import { useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { promptApiAvailability } from "@tanstack-ai-browser/prompt-api"
import {
  DEFAULT_OPPONENT,
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
function PositionSummary({
  groups,
  diagnostic = false
}: {
  groups: BenchmarkResult[][]
  diagnostic?: boolean
}) {
  return (
    <div className="table-scroll">
      <table className="summary-table">
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col">Partition</th>
            <th scope="col">
              {diagnostic ? "Observed signal" : "Objective met"}
            </th>
            <th scope="col">Legal choices</th>
            <th scope="col">Median time</th>
          </tr>
        </thead>
        <tbody>
          {groups.length ? (
            groups.map((trials) => {
              const signals = trials.filter((trial) => trial.signal !== null)
              return (
                <tr key={trials[0].caseId}>
                  <td className="position-label">{trials[0].label}</td>
                  <td>
                    {trials[0].partition === "holdout"
                      ? "Held out"
                      : "Calibration"}
                  </td>
                  <td>
                    {diagnostic
                      ? signals.length
                        ? `${signals.filter((trial) => trial.signal).length} / ${signals.length}`
                        : "Inspection only"
                      : `${trials.filter((trial) => trial.passed).length} / ${trials.length}`}
                  </td>
                  <td>
                    {trials.filter((trial) => trial.legal).length} /{" "}
                    {trials.length}
                  </td>
                  <td>
                    {seconds(median(trials.map((trial) => trial.seconds)))}
                  </td>
                </tr>
              )
            })
          ) : (
            <tr className="empty-row">
              <td colSpan={5}>
                {diagnostic
                  ? "Diagnostic observations will appear separately from scored objectives."
                  : "Scored results will appear as trials finish."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
function Detail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      <pre>{children}</pre>
    </section>
  )
}

export function BenchmarkView() {
  const [model, setModel] = useState<OpponentModel>(DEFAULT_OPPONENT.model)
  const [promptAvailable, setPromptAvailable] = useState(false)
  const [position, setPosition] = useState("calibration")
  const [thinking, setThinking] = useState(false)
  const [repetitions, setRepetitions] = useState(2)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [report, setReport] = useState<BenchmarkReport>()
  const [partialReport, setPartialReport] = useState<Record<string, unknown>>()
  const [runReasoning, setRunReasoning] = useState({
    enabled: false,
    supported: true
  })
  const [status, setStatus] = useState(
    "Ready. Every model uses the same prompt and position facts."
  )
  const [error, setError] = useState<string>()
  const controller = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const support =
    model === "prompt-api" ? "none" : opponentOption(model).thinking
  const reasoningSupported = support !== "none"
  const effectiveThinking =
    support === "required" || (support === "optional" && thinking)
  const selectedCases =
    position === "all"
      ? CASES
      : position === "calibration" || position === "holdout"
        ? CASES.filter((testCase) =>
            position === "calibration"
              ? testCase.partition !== "holdout"
              : testCase.partition === "holdout"
          )
        : CASES.filter((testCase) => testCase.id === position)
  const plannedTrials =
    selectedCases.length * (Number.isFinite(repetitions) ? repetitions : 0)
  const grouped = useMemo(() => {
    const groups = new Map<string, BenchmarkResult[]>()
    for (const result of results)
      groups.set(result.caseId, [...(groups.get(result.caseId) ?? []), result])
    return Array.from(groups.values())
  }, [results])
  const scored = results.filter((result) => result.passed !== null)
  const diagnostics = results.filter((result) => result.passed === null)

  useEffect(() => {
    mounted.current = true
    void promptApiAvailability()
      .then((availability) => {
        if (mounted.current) setPromptAvailable(availability !== "unavailable")
      })
      .catch(() => {
        /* WebGL remains available when Prompt API detection fails. */
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
      requestedThinking: effectiveThinking,
      reasoningSupported,
      repetitions,
      caseIds: selectedCases.map((testCase) => testCase.id),
      reasoningBudgetTokens: 512,
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
    setRunReasoning({
      enabled: effectiveThinking,
      supported: reasoningSupported
    })
    setError(undefined)
    setStatus("Preparing model and positions…")
    try {
      const completed = await runBenchmark({
        model,
        thinking: effectiveThinking,
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
      setRunReasoning({
        enabled: completed.config.thinking,
        supported: completed.config.reasoningSupported
      })
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
          "The run stopped after an error. Completed trials and available reasoning are printed below."
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
            One shared chess prompt. The same positions and facts for every
            model. Inspect the move, its objective, and the model’s actual
            response.
          </p>
        </div>
        <span className="manual-badge">Manual diagnostic</span>
      </header>
      <form className="controls-panel" onSubmit={start}>
        <fieldset disabled={running}>
          <legend>Run configuration</legend>
          <div className="control-grid">
            <label>
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
                    {opponentOption("prompt-api").label} (Prompt API)
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
            <div className="reasoning-control">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={effectiveThinking}
                  disabled={!reasoningSupported || support === "required"}
                  onChange={(event) => setThinking(event.target.checked)}
                />
                <span>
                  Reasoning{support === "required" ? " (always on)" : ""}
                </span>
              </label>
              <p>
                {model === "prompt-api"
                  ? "Prompt API does not expose a reasoning mode or reasoning trace for this model."
                  : !reasoningSupported
                    ? "This model does not support reasoning mode."
                    : support === "required"
                      ? "This model always uses reasoning. Available reasoning is printed with each result."
                      : "Print the model’s actual reasoning when it is available."}
              </p>
            </div>
          </div>
          <div className="configuration-notes">
            <span>
              Reasoning budget: <strong>512 tokens</strong>
            </span>
            <span>
              Output cap: <strong>8,192 tokens</strong>
            </span>
            <span>{plannedTrials} trials</span>
          </div>
          <details className="advanced-options">
            <summary>Advanced: positions</summary>
            <label>
              Position set
              <select
                value={position}
                onChange={(event) => setPosition(event.target.value)}
              >
                <option value="all">All positions ({CASES.length})</option>
                <option value="calibration">
                  Calibration positions (
                  {
                    CASES.filter((testCase) => testCase.partition !== "holdout")
                      .length
                  }
                  )
                </option>
                <option value="holdout">
                  Held-out positions (
                  {
                    CASES.filter((testCase) => testCase.partition === "holdout")
                      .length
                  }
                  )
                </option>
                {CASES.map((testCase) => (
                  <option key={testCase.id} value={testCase.id}>
                    {testCase.label}
                  </option>
                ))}
              </select>
            </label>
          </details>
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
          Runs only when you press Run. Models may download on first use.
          Results stay on this page; your saved game is untouched. Reasoning
          text is shown only when the model actually provides it.
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
      <div className="score-strip">
        <span>
          <strong>
            {scored.filter((result) => result.passed).length} / {scored.length}
          </strong>{" "}
          scored objectives met
        </span>
        <span>
          <strong>
            {results.filter((result) => result.legal).length} / {results.length}
          </strong>{" "}
          legal choices
        </span>
        <span>
          <strong>{diagnostics.length}</strong> diagnostic trials, ungraded
        </span>
      </div>
      <section className="results-section" aria-labelledby="scored-heading">
        <div className="section-heading">
          <h2 id="scored-heading">Scored objectives</h2>
          <p>
            Measures the stated objective, without claiming an engine-best move.
          </p>
        </div>
        <PositionSummary
          groups={grouped.filter((trials) => trials[0].passed !== null)}
        />
      </section>
      <section
        className="results-section"
        aria-labelledby="diagnostics-heading"
      >
        <div className="section-heading">
          <h2 id="diagnostics-heading">Diagnostic observations</h2>
          <p>
            Descriptive signals. No pass/fail grade or preference is implied.
          </p>
        </div>
        <PositionSummary
          groups={grouped.filter((trials) => trials[0].passed === null)}
          diagnostic
        />
      </section>
      <section className="results-section" aria-labelledby="trials-heading">
        <div className="section-heading">
          <h2 id="trials-heading">Trial ledger</h2>
          <p>
            Expand a trial for its objective, accepted moves, prompt, reasoning,
            and answer.
          </p>
        </div>
        <div className="table-scroll">
          <table className="trials-table">
            <thead>
              <tr>
                <th scope="col">Trial / position</th>
                <th scope="col">Selected move</th>
                <th scope="col">Choice</th>
                <th scope="col">Legal</th>
                <th scope="col">Objective</th>
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
                      <span className="partition-label">
                        {result.partition === "holdout"
                          ? "Held out"
                          : "Calibration"}
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
                        className={`badge ${result.legal ? "good" : "bad"}`}
                      >
                        {result.legal
                          ? "Legal"
                          : result.error
                            ? "Error"
                            : "Invalid"}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`badge ${result.passed === null ? "neutral" : result.passed ? "good" : "bad"}`}
                      >
                        {result.passed === null
                          ? "Diagnostic"
                          : result.passed
                            ? "Met"
                            : "Not met"}
                      </span>
                    </td>
                    <td className="numeric">{seconds(result.seconds)}</td>
                    <td className="error-cell">{result.error ?? "—"}</td>
                  </tr>
                  <tr className="detail-row">
                    <td colSpan={7}>
                      <details>
                        <summary>Inspect objective and model response</summary>
                        <div className="trial-detail">
                          <Detail title="Objective">{result.objective}</Detail>
                          <Detail title="Accepted moves">
                            {result.expectedMoveIds?.join(", ") ??
                              "Ungraded diagnostic. No best move is asserted."}
                          </Detail>
                          {CASES.find(
                            (testCase) => testCase.id === result.caseId
                          )?.signalDescription && (
                            <Detail title="Diagnostic signal">
                              {
                                CASES.find(
                                  (testCase) => testCase.id === result.caseId
                                )?.signalDescription
                              }
                            </Detail>
                          )}
                          {result.condition && (
                            <Detail title="Condition">
                              {result.condition}
                            </Detail>
                          )}
                          {result.prompt && (
                            <Detail title="Exact shared prompt">
                              {result.prompt}
                            </Detail>
                          )}
                          <Detail title="Exact ordered choices">
                            {result.choices
                              .map(
                                (choice, index) =>
                                  `${index + 1}. ${choice.id}\n${choice.outcome}`
                              )
                              .join("\n\n") || "No choices recorded."}
                          </Detail>
                          <Detail title="Actual reasoning trace">
                            {result.reasoningText ||
                              (!runReasoning.supported
                                ? "This model/API does not expose a reasoning trace."
                                : !runReasoning.enabled
                                  ? "Reasoning was off for this run."
                                  : "No reasoning trace was returned for this trial.")}
                          </Detail>
                          <Detail title="Raw model answer">
                            {result.rawAnswer ?? "No answer recorded."}
                          </Detail>
                          {result.error && (
                            <Detail title="Error">{result.error}</Detail>
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
