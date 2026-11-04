import { memo, useState } from "react"
import type { ReactNode } from "react"
import type { BenchmarkResult } from "../../bench/types"

const time = (seconds: number | null) => seconds === null ? "—" : `${seconds.toFixed(2)}s`
const grade = (result: BenchmarkResult) => !result.inference ? "Forced move" : result.error ? "Error" : result.passed === null ? "Diagnostic" : result.passed ? "Pass" : "Miss"
const json = (value: unknown) => JSON.stringify(value, null, 2)

function Detail({ title, children, pre = true }: { title: string; children: () => ReactNode; pre?: boolean }) {
  const [open, setOpen] = useState(false)
  return <details className="bench-detail" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>
    {open && (pre ? <pre>{children()}</pre> : children())}
  </details>
}

function TrialDetails({ result }: { result: BenchmarkResult }) {
  const board = result.position.board
  const boardText = ["    a b c d e f g h", ...Array.from({ length: 8 }, (_, row) => `${8 - row}   ${board.slice(row * 8, row * 8 + 8).map(piece => !piece ? "." : piece.side === "ai" ? piece.king ? "B" : "b" : piece.king ? "R" : "r").join(" ")}`), "", "Black b/B; Red r/R. Uppercase = king."].join("\n")
  return (
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
      <Detail title="Position before move">{() => boardText}</Detail>
      <Detail title="Every legal move and its outcome" pre={false}>{() => (
        <div className="bench-choice-list">{result.choices.map(choice => <article key={choice.id} className={choice.id === result.moveId ? "bench-choice-chosen" : undefined}><h4>{choice.label} <span>{choice.id}</span></h4><p>{choice.outcome}</p></article>)}</div>
      )}</Detail>
      <Detail title="Model answer">{() => result.rawAnswer ?? "No raw answer was returned."}</Detail>
      <Detail title="System prompt">{() => result.systemPrompt || "No system prompt."}</Detail>
      <Detail title="Full position prompt">{() => result.prompt ?? "No prompt was sent."}</Detail>
      <Detail title="Reasoning / working notes">{() => result.reasoningText || "No reasoning text was returned. The report records the configured reasoning mode."}</Detail>
      <Detail title="Usage">{() => result.usage ? json(result.usage) : "No usage was reported."}</Detail>
      <Detail title="Complete trial JSON">{() => json(result)}</Detail>
    </div>
  )
}

export const Trial = memo(function Trial({ result }: { result: BenchmarkResult }) {
  const [open, setOpen] = useState(false)
  return <details className={`bench-trial${result.passed === false || result.error ? " bench-trial-miss" : ""}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="bench-trial-number">{result.trial}</span>
      <span className="bench-trial-name">{result.label}<small>Repetition {result.repetition} · {result.partition}</small></span>
      <span className="bench-trial-move">{result.moveId ?? "No move"}</span>
      <span className={`bench-grade${result.passed === true ? " bench-grade-pass" : result.passed === false || result.error ? " bench-grade-miss" : ""}`}>{grade(result)}</span>
      <span className="bench-trial-time">{time(result.seconds)}</span>
    </summary>
    {open && <TrialDetails result={result} />}
  </details>
})
