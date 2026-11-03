import { Link } from "@tanstack/react-router"
import { loadPromptApiModel } from "@tanstack-ai-browser/prompt-api"
import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { CASES, SUITE_VERSION } from "../../bench/cases"
import { median, runBenchmark, summarize } from "../../bench/runner"
import type { BenchmarkReport, BenchmarkResult } from "../../bench/types"
import {
  DEFAULT_OPPONENT,
  opponentOption,
  resolveOpponent
} from "../lib/opponents"
import { usePromptApiAvailable } from "../lib/use-prompt-api"
import { OpponentPicker } from "./opponent-picker"
import { ThemeSelect } from "./theme-select"

const time = (seconds: number | null) =>
  seconds === null ? "—" : `${seconds.toFixed(2)}s`
const json = (value: unknown) => JSON.stringify(value, null, 2)
const pitLabel = (pit?: number) => (pit === undefined ? "—" : `Pit ${pit - 6}`)

function Trial({ result }: { result: BenchmarkResult }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mb-trial"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span
          className={`mb-verdict ${result.error || !result.legal ? "mb-fail" : result.passed === null ? "" : result.passed ? "mb-pass" : "mb-fail"}`}
        >
          {result.error
            ? "Error"
            : !result.legal
              ? "Illegal"
              : result.passed === null
                ? "Observed"
                : result.passed
                  ? "Pass"
                  : "Miss"}
        </span>
        <span>
          {result.label}
          <small>Repetition {result.repetition}</small>
        </span>
        <span>{pitLabel(result.pit)}</span>
        <span>{time(result.seconds)}</span>
      </summary>
      {open && (
        <div className="mb-trial-body">
          {result.error && (
            <p role="alert" className="mb-error">
              {result.error}
            </p>
          )}
          <p>
            Expected:{" "}
            {result.expectedPits
              ? result.expectedPits.map(pitLabel).join(", ")
              : "Ungraded diagnostic"}
            . Presented order: {result.order.map((pit) => pit - 6).join(", ")}.
          </p>
          <dl>
            <div>
              <dt>Human pits 1–6</dt>
              <dd>{result.position.board.slice(0, 6).join(" · ")}</dd>
            </div>
            <div>
              <dt>AI pits 1–6</dt>
              <dd>{result.position.board.slice(7, 13).join(" · ")}</dd>
            </div>
            <div>
              <dt>Stores: Human / AI</dt>
              <dd>
                {result.position.board[6]} / {result.position.board[13]}
              </dd>
            </div>
          </dl>
          {result.input?.choices.map((choice) => (
            <div className="mb-choice" key={choice.id}>
              <strong>Pit {choice.label}</strong>
              <p>{choice.outcome}</p>
            </div>
          ))}
          <details>
            <summary>Exact system prompt</summary>
            <pre>{result.input?.systemPrompt ?? "No prompt captured."}</pre>
          </details>
          <details>
            <summary>Exact position prompt</summary>
            <pre>{result.input?.prompt ?? "No prompt captured."}</pre>
          </details>
          <details>
            <summary>Model answer and reasoning</summary>
            <pre>{result.rawAnswer ?? "No raw answer captured."}</pre>
            <pre>{result.reasoning || "No reasoning returned."}</pre>
          </details>
          {result.usage && (
            <details>
              <summary>Provider usage</summary>
              <pre>{json(result.usage)}</pre>
            </details>
          )}
        </div>
      )}
    </details>
  )
}

export function BenchmarkView() {
  const [opponent, setOpponent] = useState(DEFAULT_OPPONENT)
  const [repetitions, setRepetitions] = useState(2)
  const [budget, setBudget] = useState(512)
  const [selection, setSelection] = useState("calibration")
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [report, setReport] = useState<BenchmarkReport>()
  const [status, setStatus] = useState(
    "Choose your settings. The model runs when you press Run benchmark."
  )
  const [error, setError] = useState<string>()
  const [copyStatus, setCopyStatus] = useState("")
  const [reportOpen, setReportOpen] = useState(false)
  const [loadStatus, setLoadStatus] = useState("")
  const controller = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const promptApiAvailable = usePromptApiAvailable()
  const selected =
    selection === "all"
      ? CASES
      : selection === "failed"
        ? CASES.filter((testCase) =>
            results.some(
              (result) =>
                result.caseId === testCase.id &&
                (result.error || result.passed === false)
            )
          )
        : selection === "calibration" || selection === "holdout"
          ? CASES.filter((testCase) => testCase.partition === selection)
          : CASES.filter((testCase) => testCase.id === selection)
  const summary = summarize(results)
  const selectedLabel = opponentOption(opponent.model).label

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    void import("../lib/ai")
      .then((ai) => {
        if (!active) return
        const store = ai.loadingStoreFor(opponent)
        const sync = () => {
          if (!active) return
          const value = store.get()
          setLoadStatus(
            value.state === "loading"
              ? `${value.cached ? "Loading cached model" : "Downloading model"}: ${Math.round(value.progress * 100)}%`
              : value.state === "ready"
                ? "Model ready"
                : ""
          )
        }
        unsubscribe = store.subscribe(sync)
        sync()
      })
      .catch(() => {
        /* The inference action reports runtime import failures. */
      })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [opponent])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      controller.current ||
      !selected.length ||
      !event.currentTarget.reportValidity()
    )
      return
    const active = new AbortController()
    const caseIds = selected.map((testCase) => testCase.id)
    controller.current = active
    setRunning(true)
    setResults([])
    setReport(undefined)
    setError(undefined)
    setCopyStatus("")
    setStatus("Preparing positions and selected model…")
    try {
      const output = await runBenchmark({
        opponent,
        repetitions,
        reasoningBudgetTokens: budget,
        caseIds,
        signal: active.signal,
        onResult: (result) => {
          if (mounted.current && controller.current === active)
            setResults((previous) => [...previous, result])
        },
        onProgress: (message) => {
          if (
            mounted.current &&
            controller.current === active &&
            !active.signal.aborted
          )
            setStatus(message)
        }
      })
      if (mounted.current) {
        setReport(output)
        setStatus(
          `${output.partial ? "Stopped" : "Complete"}. ${output.results.length} completed trials retained.`
        )
      }
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
        setStatus("Run ended. Completed trials remain below.")
      }
    } finally {
      if (controller.current === active) controller.current = undefined
      if (mounted.current) setRunning(false)
    }
  }
  const fullReport = report ?? {
    schemaVersion: 1,
    partial: true,
    suiteVersion: SUITE_VERSION,
    results,
    summary
  }
  return (
    <main className="mancala-bench">
      <header className="mb-header">
        <Link to="/" className="mb-brand">
          Mancala
        </Link>
        <div>
          <Link to="/game">Back to board</Link>
          <ThemeSelect />
        </div>
      </header>
      <section className="mb-intro">
        <span className="mb-kicker">At the practice board</span>
        <h1>
          How does your
          <br />
          opponent think?
        </h1>
        <p>
          Compare local models on captures, bonus turns, and the final sweep.
          Every choice comes through the same prompt and AI path as your game.
        </p>
      </section>
      <form
        onSubmit={(event) => {
          void start(event)
        }}
        className="mb-controls"
      >
        <div className="mb-model">
          <span>Opponent model</span>
          <OpponentPicker
            value={opponent}
            promptApiAvailable={promptApiAvailable}
            disabled={running}
            onChange={(value) => {
              setOpponent(resolveOpponent(value))
              if (value.model === "prompt-api" && promptApiAvailable)
                void loadPromptApiModel().catch((failure: unknown) =>
                  setError(
                    failure instanceof Error ? failure.message : String(failure)
                  )
                )
            }}
          />
        </div>
        <fieldset disabled={running}>
          <legend className="mb-sr-only">Benchmark settings</legend>
          <label>
            Positions
            <select
              aria-label="Benchmark positions"
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="calibration">Calibration positions</option>
              <option value="holdout">Holdout positions</option>
              <option value="all">All positions</option>
              <option value="failed">Retry previous failures</option>
              <optgroup label="Single position">
                {CASES.map((testCase) => (
                  <option key={testCase.id} value={testCase.id}>
                    {testCase.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Repetitions
            <input
              aria-label="Repetitions"
              type="number"
              min={1}
              max={20}
              step={1}
              required
              value={repetitions}
              onChange={(event) => setRepetitions(Number(event.target.value))}
            />
          </label>
          <label>
            Reasoning budget
            <input
              aria-label="Reasoning budget tokens"
              type="number"
              min={0}
              max={8192}
              step={1}
              required
              value={budget}
              disabled={!opponent.thinking}
              onChange={(event) => setBudget(Number(event.target.value))}
            />
          </label>
        </fieldset>
        <p className="mb-note">
          Thinking is {opponent.thinking ? "on" : "off"}; change it in the model
          menu. Each repetition reverses or rotates the exact same legal
          choices. Times include model loading and prompt analysis; cache state
          is retained between trials. Models use their default sampling.
        </p>
        <div className="mb-actions">
          <button
            className="mb-button mb-primary"
            type="submit"
            disabled={running || !selected.length}
          >
            Run benchmark
          </button>
          <button
            className="mb-button"
            type="button"
            disabled={!running}
            onClick={() => {
              controller.current?.abort()
              setStatus("Stopping the active trial…")
            }}
          >
            Stop
          </button>
          <span>
            {selected.length} positions × {repetitions || 0} repetitions
          </span>
        </div>
      </form>
      <div className="mb-status" role="status" aria-live="polite">
        <span>{status}</span>
        {running && loadStatus && (
          <small>
            {selectedLabel}: {loadStatus}
          </small>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-error">
          {error}
        </p>
      )}
      <section className="mb-summary" aria-label="Benchmark summary">
        <div>
          <span>Objective passes</span>
          <strong>
            {summary.passed}
            <small> / {summary.scored}</small>
          </strong>
        </div>
        <div>
          <span>Legal moves</span>
          <strong>
            {summary.legal}
            <small> / {summary.total}</small>
          </strong>
        </div>
        <div>
          <span>Median decision</span>
          <strong>{time(summary.medianSeconds)}</strong>
        </div>
        <div>
          <span>First option chosen</span>
          <strong>
            {summary.firstOption}
            <small> / {summary.inferred}</small>
          </strong>
        </div>
      </section>
      <section className="mb-section">
        <div className="mb-section-heading">
          <h2>Position outcomes</h2>
          <span>{SUITE_VERSION}</span>
        </div>
        <p className="mb-note">
          A pass means the stated objective was met. These bounded tactical
          tests do not establish full-game strength. Holdout positions are for
          checking a frozen prompt.
        </p>
        <div className="mb-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th>Objective</th>
                <th>Passed</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {CASES.filter(
                (testCase) =>
                  selection === "all" ||
                  selected.some((item) => item.id === testCase.id) ||
                  results.some((result) => result.caseId === testCase.id)
              ).map((testCase) => {
                const trials = results.filter(
                  (result) => result.caseId === testCase.id
                )
                const scored = trials.filter((result) => result.passed !== null)
                return (
                  <tr key={testCase.id}>
                    <td>
                      <strong>{testCase.label}</strong>
                      <small>
                        {testCase.category} · {testCase.partition}
                      </small>
                    </td>
                    <td>{testCase.description}</td>
                    <td>
                      {!trials.length
                        ? "—"
                        : !scored.length
                          ? "Observed"
                          : `${scored.filter((result) => result.passed).length} / ${scored.length}`}
                    </td>
                    <td>
                      {time(median(trials.map((result) => result.seconds)))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="mb-section">
        <div className="mb-section-heading">
          <h2>Every decision</h2>
          <span>{results.length} completed</span>
        </div>
        <p className="mb-note">
          Open a trial for the position, all legal choices, exact prompts,
          answer, reasoning, and provider usage.
        </p>
        {results.length ? (
          results.map((result) => (
            <Trial
              key={`${result.caseId}:${result.repetition}`}
              result={result}
            />
          ))
        ) : (
          <p className="mb-empty">Your first results will appear here.</p>
        )}
      </section>
      <section className="mb-section">
        <div className="mb-section-heading">
          <h2>Run report</h2>
          <button
            className="mb-button"
            disabled={!results.length}
            onClick={() => {
              void navigator.clipboard.writeText(json(fullReport)).then(
                () => setCopyStatus("Report copied."),
                () => setCopyStatus("Select the JSON below to copy the report.")
              )
            }}
          >
            Copy JSON
          </button>
        </div>
        <p className="mb-note" aria-live="polite">
          {copyStatus ||
            "Completed trials remain available when you stop a run."}
        </p>
        <details
          className="mb-report"
          onToggle={(event) => setReportOpen(event.currentTarget.open)}
        >
          <summary>Full report JSON</summary>
          {reportOpen && (
            <pre id="benchmark-results-json">{json(fullReport)}</pre>
          )}
        </details>
      </section>
      <footer className="mb-footer">
        Models run on your device. No inference runs during builds or automated
        tests.
      </footer>
    </main>
  )
}
