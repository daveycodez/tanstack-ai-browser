import { useMemo, useRef, useState } from "react"
import { buildTurnLog } from "../lib/turn-log"
import type { Game } from "../lib/checkers"

export function TurnLog({ game }: { game: Game }) {
  const report = useMemo(() => buildTurnLog(game), [game])
  const serialized = useMemo(() => JSON.stringify(report, null, 2), [report])
  const [copy, setCopy] = useState<{ text: string; message: string }>()
  const details = useRef<HTMLDetailsElement>(null)
  const text = useRef<HTMLPreElement>(null)
  async function copyLog() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(serialized)
      setCopy({ text: serialized, message: "Full turn log copied." })
    } catch {
      if (details.current) details.current.open = true
      text.current?.focus()
      if (text.current) {
        const range = document.createRange()
        range.selectNodeContents(text.current)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      setCopy({ text: serialized, message: "Log selected. Copy the text below manually." })
    }
  }
  return <section className="turn-log-shell" aria-labelledby="turn-log-title">
    <div className="turn-log-heading">
      <div><h2 id="turn-log-title">Full turn log</h2><p>Copy this log when a move looks wrong.</p></div>
      <button type="button" className="button button-small button-secondary" onClick={() => { void copyLog() }}>Copy log</button>
    </div>
    <p className="turn-log-copy-status" aria-live="polite">{copy?.text === serialized ? copy.message : ""}</p>
    {game.history.length ? <ol className="turn-log-list">
      {game.history.map((move, index) => <li key={`${index}-${move.notation}`}>
        <span className="turn-log-ply">{index + 1}.</span><span>{move.side === "human" ? "You" : "Opponent"}</span><strong>{move.notation}</strong>
        {move.side === "ai" && <span className="turn-log-decision">{move.analysis ? move.analysis.mode === "forced" ? "Only legal move" : `${move.analysis.model.split("/").at(-1)} · ${(move.analysis.elapsedMs / 1000).toFixed(2)}s` : "Earlier move: AI details unavailable"}</span>}
      </li>)}
    </ol> : <p className="turn-log-empty">Moves will appear here as the game is played.</p>}
    {!!report.failedAiAttempts.length && <p className="turn-log-failures">{report.failedAiAttempts.length} failed AI {report.failedAiAttempts.length === 1 ? "attempt is" : "attempts are"} included in the log.</p>}
    <details className="turn-log-json" ref={details}>
      <summary>Full log data · {game.history.length} turns</summary>
      <pre ref={text} tabIndex={0} aria-label="Full turn log JSON">{serialized}</pre>
    </details>
  </section>
}
