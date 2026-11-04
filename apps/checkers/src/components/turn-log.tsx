import { useEffect, useMemo, useRef, useState } from "react"
import { buildTurnLog } from "../lib/turn-log"
import type { Game } from "../lib/checkers"

export function TurnLog({ game }: { game: Game }) {
  const [expanded, setExpanded] = useState(false)
  const serialized = useMemo(() => expanded ? JSON.stringify(buildTurnLog(game), null, 2) : undefined, [game, expanded])
  const revision = game.storageVersion ?? `${game.sessionId}:${game.updatedAt}:${game.history.length}:${game.aiFailures?.length ?? 0}`
  const [copy, setCopy] = useState<{ revision: string; message: string; select?: boolean }>()
  const details = useRef<HTMLDetailsElement>(null)
  const text = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (!expanded || copy?.revision !== revision || !copy.select || !text.current) return
    text.current.focus()
    const range = document.createRange()
    range.selectNodeContents(text.current)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [copy, expanded, revision])
  async function copyLog() {
    const fullLog = serialized ?? JSON.stringify(buildTurnLog(game), null, 2)
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(fullLog)
      setCopy({ revision, message: "Full turn log copied." })
    } catch {
      if (details.current) details.current.open = true
      setExpanded(true)
      setCopy({ revision, select: true, message: "Log selected. Copy the text below manually." })
    }
  }
  return <section className="turn-log-shell" aria-labelledby="turn-log-title">
    <div className="turn-log-heading">
      <div><h2 id="turn-log-title">Full turn log</h2><p>Copy this log when a move looks wrong.</p></div>
      <button type="button" className="button button-small button-secondary" onClick={() => { void copyLog() }}>Copy log</button>
    </div>
    <p className="turn-log-copy-status" aria-live="polite">{copy?.revision === revision ? copy.message : ""}</p>
    {game.history.length ? <ol className="turn-log-list">
      {game.history.map((move, index) => <li key={`${index}-${move.notation}`}>
        <span className="turn-log-ply">{index + 1}.</span><span>{move.side === "human" ? "You" : "Opponent"}</span><strong>{move.notation}</strong>
        {move.side === "ai" && <span className="turn-log-decision">{move.analysis ? move.analysis.mode === "forced" ? "Only legal move" : `${move.analysis.model.split("/").at(-1)} · ${(move.analysis.elapsedMs / 1000).toFixed(2)}s` : "Earlier move: AI details unavailable"}</span>}
      </li>)}
    </ol> : <p className="turn-log-empty">Moves will appear here as the game is played.</p>}
    {!!game.aiFailures?.length && <p className="turn-log-failures">{game.aiFailures.length} failed AI {game.aiFailures.length === 1 ? "attempt is" : "attempts are"} included in the log.</p>}
    <details className="turn-log-json" ref={details} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>Full log data · {game.history.length} turns</summary>
      {expanded && <pre ref={text} tabIndex={0} aria-label="Full turn log JSON">{serialized}</pre>}
    </details>
  </section>
}
