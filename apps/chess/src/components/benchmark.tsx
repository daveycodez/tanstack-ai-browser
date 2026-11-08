import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { FormEvent, ReactNode } from "react"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"
import {
  DEFAULT_OPPONENT,
  LOCAL_OPPONENTS,
  isWebGlOpponent,
  usesEmulatedReasoning,
  opponentOption
} from "../lib/opponents"
import type { OpponentModel } from "../lib/opponents"
import { CASES } from "../../bench/cases"
import { CACHE_REPLAY_CASES } from "../../bench/cache-replay"
import { runBenchmark } from "../../bench/runner"
import { runBenchmarkInFrame } from "../../bench/run-in-frame"
import type { RuntimeOptions } from "../../bench/run-in-frame"
import type {
  BenchmarkReport,
  BenchmarkResult,
  ReasoningMode
} from "../../bench/types"

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

type RunReasoning = { enabled: boolean; supported: boolean; mode: ReasoningMode }
const EMPTY_REPORT = { results: [] }
const subscribePlatform = () => () => undefined
const macSnapshot = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform) && navigator.maxTouchPoints === 0
const PARALLEL_MODELS = ["prompt-api", ...(import.meta.env?.DEV === true ? ["apple-foundationmodel" as const] : []), "LiquidAI/LFM3-1.7B-GGUF", "unsloth/Qwen3.5-2B-GGUF"] as const
type BatchModel = typeof PARALLEL_MODELS[number]
type BatchSlot = {
  model: BatchModel
  config: RuntimeOptions
  results: BenchmarkResult[]
  report?: BenchmarkReport
  reasoning: RunReasoning
  error?: string
}
type BatchState = Partial<Record<BatchModel, BatchSlot>>

function LazyDetails({ summary, className, children }: {
  summary: string
  className?: string
  children: () => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <details className={className} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  )
}
const ReportJson = memo(function ReportJson({ report, id = "benchmark-results-json" }: { report: object; id?: string }) {
  const json = useMemo(() => JSON.stringify(report, null, 2), [report])
  return <pre id={id}>{json}</pre>
})

const TrialRow = memo(function TrialRow({ result, runReasoning }: {
  result: BenchmarkResult
  runReasoning: RunReasoning
}) {
  return (
    <tbody>
      <tr>
        <td className="position-label">
          {result.trial}. {result.label}
          <span className="partition-label">
            {result.partition === "holdout"
              ? "Held out"
              : "Calibration"}
          </span>
        </td>
        <td className="move-code">
          {result.choices.find((choice) => choice.id === result.moveId)
            ?.notation ?? result.rawAnswer ?? result.moveId ?? "—"}
        </td>
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
          <LazyDetails summary="Inspect objective and model response">
            {() => <div className="trial-detail">
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
              {result.systemPrompt && (
                <Detail title="Exact shared system instruction">
                  {result.systemPrompt}
                </Detail>
              )}
              {result.prompt && (
                <Detail title="Exact shared user prompt">
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
              <Detail
                title={
                  runReasoning.mode === "emulated-working-notes"
                    ? "Prompt API working notes (emulated)"
                    : runReasoning.mode === "native"
                      ? "Native reasoning trace"
                      : "Reasoning output"
                }
              >
                {result.reasoningText ||
                  (!runReasoning.supported
                    ? "This model/API does not expose a reasoning trace."
                    : !runReasoning.enabled
                      ? "Reasoning was off for this run."
                      : runReasoning.mode ===
                          "emulated-working-notes"
                        ? "No working notes were returned for this trial."
                        : "No reasoning trace was returned for this trial.")}
              </Detail>
              {result.usage && (
                <Detail title="Provider usage">
                  {JSON.stringify(result.usage, null, 2)}
                </Detail>
              )}
              <Detail title="Raw model answer">
                {result.rawAnswer ?? "No answer recorded."}
              </Detail>
              {result.error && (
                <Detail title="Error">{result.error}</Detail>
              )}
            </div>}
          </LazyDetails>
        </td>
      </tr>
    </tbody>
  )
})

export function BenchmarkView() {
  const [model, setModel] = useState<OpponentModel>(DEFAULT_OPPONENT.model)
  const [promptAvailable, setPromptAvailable] = useState(false)
  const [position, setPosition] = useState("calibration")
  const [thinking, setThinking] = useState(false)
  const [movePresentation, setMovePresentation] = useState<"game" | "new-games" | "stress">("game")
  const [moveOrderSeed, setMoveOrderSeed] = useState("chess-benchmark-v1")
  const [repetitions, setRepetitions] = useState(2)
  const [disablePromptCache, setDisablePromptCache] = useState(false)
  const [otherGpuWorkload, setOtherGpuWorkload] = useState(false)
  const [webglTemperature, setWebglTemperature] = useState<number>()
  const [reasoningBudgetTokens, setReasoningBudgetTokens] = useState<
    512 | 1024 | null
  >(512)
  const [running, setRunning] = useState(false)
  const [singleResults, setResults] = useState<BenchmarkResult[]>([])
  const [singleReport, setReport] = useState<BenchmarkReport>()
  const [singlePartialReport, setPartialReport] = useState<Record<string, unknown>>()
  const [singleRunReasoning, setRunReasoning] = useState<RunReasoning>({
    enabled: false,
    supported: true,
    mode: "off"
  })
  const [singleStatus, setStatus] = useState(
    "Ready. Every model uses the same prompt and position facts."
  )
  const [singleError, setError] = useState<string>()
  const parallelMac = useSyncExternalStore(subscribePlatform, macSnapshot, () => false)
  const [batch, setBatch] = useState<BatchState>()
  const [batchProgress, setBatchProgress] = useState<Partial<Record<BatchModel, string>>>({})
  const [viewedModel, setViewedModel] = useState<BatchModel>("unsloth/Qwen3.5-2B-GGUF")
  const activeBatch = batch?.[viewedModel]
  const results = activeBatch ? activeBatch.results : singleResults
  const report = activeBatch ? activeBatch.report : singleReport
  const status = activeBatch ? batchProgress[viewedModel] ?? "Preparing model…" : singleStatus
  const error = activeBatch ? activeBatch.error : singleError
  const runReasoning = activeBatch ? activeBatch.reasoning : singleRunReasoning
  const partialReport = useMemo(() => activeBatch ? {
    partial: true, choiceIndexBase: 0, config: activeBatch.config, results: activeBatch.results
  } : singlePartialReport, [activeBatch, singlePartialReport])
  const batchReport = useMemo(() => batch ? {
    schemaVersion: 1, mode: "mac-parallel", timingComparable: false,
    reports: PARALLEL_MODELS.map(model => {
      const slot = batch[model]
      return { model, error: slot?.error, report: slot?.report ?? {
        partial: true, choiceIndexBase: 0, config: slot?.config, results: slot?.results ?? []
      } }
    })
  } : undefined, [batch])
  const controller = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const support = opponentOption(model).thinking
  const reasoningSupported = support !== "none"
  const effectiveThinking =
    support === "required" || (support === "optional" && thinking)
  const selectedCases =
    position === "cache-replay"
      ? CACHE_REPLAY_CASES
      : position === "all"
      ? CASES
      : position === "calibration" || position === "holdout"
        ? CASES.filter((testCase) =>
            position === "calibration"
              ? testCase.partition !== "holdout"
              : testCase.partition === "holdout"
          )
        : position === "observed"
          ? CASES.filter((testCase) => testCase.id.startsWith("observed-"))
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
  const cacheResults = results.filter(result =>
    typeof result.usage?.promptTokens === "number"
  )
  const cachedTokens = cacheResults.reduce((sum, result) =>
    sum + (result.usage?.promptTokensDetails?.cachedTokens ?? 0), 0)
  const inputTokens = cacheResults.reduce((sum, result) =>
    sum + (result.usage?.promptTokens ?? 0), 0)

  useEffect(() => {
    mounted.current = true
    void promptApiText("built-in")
      .availability()
      .then((availability) => availability !== "unavailable")
      .then((supported) => {
        if (mounted.current) setPromptAvailable(supported)
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
    setBatch(undefined)
    const startedAt = new Date().toISOString()
    const config = {
      model,
      thinking: effectiveThinking,
      requestedThinking: effectiveThinking,
      reasoningSupported,
      reasoningMode: !effectiveThinking
        ? "off"
        : usesEmulatedReasoning(model)
          ? "emulated-working-notes"
          : "native",
      repetitions,
      disablePromptCache,
      otherGpuWorkload,
      promptCache: disablePromptCache ? "none" : "default",
      timingComparable: !otherGpuWorkload,
      movePresentation,
      moveOrderSeed,
      caseIds: selectedCases.map((testCase) => testCase.id),
      reasoningBudgetTokens,
      maxOutputTokens: model === "prompt-api" ? null : 8192,
      sampling: isWebGlOpponent(model) && webglTemperature !== undefined ? "temperature override" : "model defaults",
      ...(isWebGlOpponent(model) && webglTemperature !== undefined && { webglTemperature })
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
      supported: reasoningSupported,
      mode: config.reasoningMode as ReasoningMode
    })
    setError(undefined)
    setStatus("Preparing model and positions…")
    try {
      const completed = await runBenchmark({
        model,
        thinking: effectiveThinking,
        repetitions,
        disablePromptCache,
        otherGpuWorkload,
        movePresentation,
        moveOrderSeed,
        reasoningBudgetTokens,
        webglTemperature,
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
        supported: completed.config.reasoningSupported,
        mode: completed.config.reasoningMode
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


  async function startParallel() {
    if (controller.current || !parallelMac || !promptAvailable) return
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20 || !selectedCases.length) {
      setError("Choose 1–20 repetitions and a valid position set.")
      return
    }
    const active = new AbortController()
    controller.current = active
    const common = {
      thinking: effectiveThinking, repetitions, disablePromptCache,
      otherGpuWorkload: true, movePresentation, moveOrderSeed,
      reasoningBudgetTokens, webglTemperature, caseIds: selectedCases.map(item => item.id)
    }
    const initial: BatchState = {}
    for (const target of PARALLEL_MODELS) initial[target] = {
      model: target, config: { ...common, model: target }, results: [],
      reasoning: { enabled: common.thinking, supported: true,
        mode: !common.thinking ? "off" : usesEmulatedReasoning(target) ? "emulated-working-notes" : "native" }
    }
    setBatch(initial)
    setViewedModel("unsloth/Qwen3.5-2B-GGUF")
    setBatchProgress({})
    setOtherGpuWorkload(true)
    setError(undefined)
    setRunning(true)
    const update = (target: BatchModel, change: (slot: BatchSlot) => BatchSlot) => {
      if (!mounted.current || controller.current !== active) return
      setBatch(previous => {
        const slot = previous?.[target]
        return previous && slot ? { ...previous, [target]: change(slot) } : previous
      })
    }
    const progress = (target: BatchModel, text: string) => {
      if (mounted.current && controller.current === active)
        setBatchProgress(previous => ({ ...previous, [target]: text }))
    }
    try {
      await Promise.allSettled(PARALLEL_MODELS.map(async target => {
        const options = {
          ...common, model: target, signal: active.signal,
          onResult: (result: BenchmarkResult) => update(target, slot => ({ ...slot, results: [...slot.results, result] })),
          onProgress: (text: string) => { if (!active.signal.aborted) progress(target, text) }
        }
        try {
          const completed = await (target === "prompt-api" ? runBenchmark(options) : runBenchmarkInFrame(options))
          update(target, slot => ({ ...slot, report: completed, results: completed.results,
            reasoning: { enabled: completed.config.thinking, supported: completed.config.reasoningSupported, mode: completed.config.reasoningMode } }))
          progress(target, `${completed.partial ? "Stopped" : "Complete"}. ${completed.results.length} trials finished.`)
        } catch (failure) {
          if (active.signal.aborted) progress(target, "Stopped. Completed trials are preserved.")
          else {
            const message = failure instanceof Error ? failure.message : String(failure)
            update(target, slot => ({ ...slot, error: message }))
            progress(target, "Failed. Completed trials are preserved.")
          }
        }
      }))
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
                {LOCAL_OPPONENTS.map((option) => (
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
                  {usesEmulatedReasoning(model)
                    ? "Working notes"
                    : "Reasoning"}
                  {support === "required" ? " (always on)" : ""}
                </span>
              </label>
              <p>
                {usesEmulatedReasoning(model)
                  ? "Uses a separate working-notes pass before choosing a move. These are generated notes, not native hidden reasoning."
                  : !reasoningSupported
                    ? "This model does not support reasoning mode."
                    : support === "required"
                      ? "This model always uses reasoning. Available reasoning is printed with each result."
                      : "Print the model’s actual reasoning when it is available."}
              </p>
            </div>
          </div>
          <div className="configuration-notes">
            <label className="budget-control">
              Reasoning budget
              <select
                value={reasoningBudgetTokens ?? "uncapped"}
                disabled={!reasoningSupported}
                onChange={(event) =>
                  setReasoningBudgetTokens(
                    event.target.value === "uncapped"
                      ? null
                      : (Number(event.target.value) as 512 | 1024)
                  )
                }
              >
                <option value={512}>512 tokens</option>
                <option value={1024}>1,024 tokens</option>
                <option value="uncapped">Uncapped thinking</option>
              </select>
            </label>
            <label className="budget-control">
              Move order
              <select value={movePresentation} onChange={(event) =>
                setMovePresentation(event.target.value as "game" | "new-games" | "stress")
              }>
                <option value="game">Same game (stable order)</option>
                <option value="new-games">New game per repetition</option>
                <option value="stress">Permuted stress test</option>
              </select>
            </label>
            <label className="budget-control">
              Order seed
              <input value={moveOrderSeed} disabled={movePresentation === "stress"}
                onChange={(event) => setMoveOrderSeed(event.target.value)} />
            </label>
            <label className="budget-control">
              Prompt cache
              <select value={disablePromptCache ? "none" : "default"}
                onChange={(event) => setDisablePromptCache(event.target.value === "none")}>
                <option value="default">Normal reuse</option>
                <option value="none">Disabled (control)</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={otherGpuWorkload}
                onChange={(event) => setOtherGpuWorkload(event.target.checked)} />
              <span>Other GPU workload active</span>
            </label>
            <span>
              Output cap:{" "}
              <strong>
                {model === "prompt-api" ? "Browser managed" : "8,192 tokens"}
              </strong>
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
                <option value="observed">
                  Observed games ({CASES.filter((testCase) => testCase.id.startsWith("observed-")).length})
                </option>
                <option value="cache-replay">Game cache replay (7 turns)</option>
                {CASES.map((testCase) => (
                  <option key={testCase.id} value={testCase.id}>
                    {testCase.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              WebGL temperature (diagnostic)
              <input type="number" min={0} max={2} step={0.05} placeholder="Model default"
                value={webglTemperature ?? ""} onChange={event => setWebglTemperature(event.target.value === "" ? undefined : Number(event.target.value))} />
            </label>
            <p>Blank uses vendor defaults. This override applies to WebGL models; Prompt API keeps browser sampling.</p>
          </details>
        </fieldset>
        <div className="run-actions">
          <button className="button primary" type="submit" disabled={running}>
            Run benchmark
          </button>
          {parallelMac && (
            <button className="button" type="button" disabled={running || !promptAvailable} onClick={() => void startParallel()}>
              Run all {PARALLEL_MODELS.length === 4 ? "four" : "three"} (Mac parallel)
            </button>
          )}
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
          output is printed as native reasoning or emulated Prompt API working
          notes, according to the mode actually used.
        </p>
      </form>
      {batch && (
        <section className="batch-results" aria-label="Parallel model results">
          <h2>Mac parallel evaluation</h2>
          <p>One tab, identical prompts and cases. Select a model to inspect its results. Timings include concurrent GPU work.</p>
          <div className="batch-models">
            {PARALLEL_MODELS.map(target => {
              const slot = batch[target]
              if (!slot) return null
              const scored = slot.results.filter(result => result.passed !== null)
              const usage = slot.results.flatMap(result => typeof result.usage?.promptTokens === "number" ? [result.usage.promptTokens] : [])
              return (
                <button className={`batch-model${viewedModel === target ? " selected" : ""}`} type="button" key={target}
                  aria-pressed={viewedModel === target} onClick={() => setViewedModel(target)}>
                  <strong>{opponentOption(target).label}</strong>
                  <span>{slot.results.filter(result => result.passed).length}/{scored.length} objectives · {slot.results.filter(result => result.legal).length}/{slot.results.length} legal</span>
                  {usage.length > 0 && <span>{Math.round(usage.reduce((sum, count) => sum + count, 0) / usage.length)} average input tokens</span>}
                  <small>{batchProgress[target] ?? "Preparing model…"}</small>
                </button>
              )
            })}
          </div>
          <p>Showing {opponentOption(viewedModel).label}. Token counts are provider-reported; each model tokenizes the same text differently.</p>
        </section>
      )}
      <section className="run-status" aria-label="Run status">
        <span className={`status-dot${running ? " running" : ""}`} />
        <p role="status" aria-live="polite">
          {status}
        </p>
        <span className="run-count">
          {results.length} {results.length === 1 ? "trial" : "trials"}
        </span>
      </section>
      {(report?.config.timingComparable === false || (running && otherGpuWorkload)) && (
        <p className="configuration-notes" role="note">Other GPU workload active: use these results for cache reuse and move quality; timings are diagnostic only.</p>
      )}
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
      {cacheResults.length > 0 && (
        <p className="configuration-notes" aria-label="Prompt cache">
          <span>Prompt cache: <strong>{cachedTokens.toLocaleString()} / {inputTokens.toLocaleString()}</strong> input tokens reused</span>
          <span>{cacheResults.filter(result => (result.usage?.promptTokensDetails?.cachedTokens ?? 0) > 0).length} / {cacheResults.length} calls reused a prefix</span>
        </p>
      )}
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
                <TrialRow key={result.trial} result={result} runReasoning={runReasoning} />
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
        <LazyDetails className="printed-report" summary="Full report JSON">
          {() => <ReportJson report={report ?? partialReport ?? EMPTY_REPORT} />}
        </LazyDetails>
      </section>
      {batchReport && (
        <section className="results-section">
          <LazyDetails className="printed-report" summary="Full batch JSON">
            {() => <ReportJson report={batchReport} id="benchmark-batch-results-json" />}
          </LazyDetails>
        </section>
      )}
      <footer className="page-footer">
        Manual diagnostic · Not part of the automated test suite · No game data
        is read or written
      </footer>
    </main>
  )
}
