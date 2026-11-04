import { useEffect, useRef, useState } from "react"
import { runBehaviorStudy } from "../../bench/behavior-study"
import type { BehaviorStudyReport } from "../../bench/behavior-study"
import { runBehaviorInFrame } from "../../bench/run-behavior-in-frame"
import type { OpponentModel, OpponentOption } from "../lib/opponents"

type Slot = { model: OpponentModel; status: string; report?: BehaviorStudyReport; error?: string }
const score = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1)
const trajectoryQuality = (report?: BehaviorStudyReport) => {
  if (!report) return "—"
  const choices = report.rollouts.traces.filter(trace => trace.mode === "model").flatMap(trace => trace.moves).filter(move => move.side === "ai" && move.source === "model")
  return `${choices.filter(move => move.referenceRegret <= 25).length}/${choices.length}`
}
export function BehaviorBenchmark({ options, disabled, onRunningChange }: { options: OpponentOption[]; disabled: boolean; onRunningChange: (running: boolean) => void }) {
  const [selected, setSelected] = useState<OpponentModel[]>()
  const defaults = options.filter(option => ["LiquidAI/LFM3-1.7B-GGUF", "unsloth/Qwen3.5-2B-GGUF", "prompt-api"].includes(option.id)).map(option => option.id)
  const models = selected ?? defaults
  const [slots, setSlots] = useState<Slot[]>([])
  const [running, setRunning] = useState(false)
  const [showJson, setShowJson] = useState(false)
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { controller.current?.abort(); controller.current = undefined }, [])
  async function start() {
    if (controller.current || disabled || !models.length) return
    const active = new AbortController(); controller.current = active; setRunning(true); setShowJson(false); onRunningChange(true)
    const current: Slot[] = models.map(model => ({ model, status: "Starting…" }))
    const publish = () => { if (controller.current === active) setSlots(current.map(slot => ({ ...slot }))) }
    publish()
    try {
      await Promise.allSettled(current.map(async slot => {
        try {
          const args = { model: slot.model, signal: active.signal, onProgress: (message: string) => { slot.status = message; publish() } }
          slot.report = await (slot.model === "prompt-api" || slot.model === "apple-foundationmodel" ? runBehaviorStudy(args) : runBehaviorInFrame(args))
          slot.status = "Complete."
        } catch (error) { slot.error = error instanceof Error ? error.message : String(error); slot.status = active.signal.aborted ? "Stopped." : "Failed." }
        publish()
      }))
    } finally { if (controller.current === active) controller.current = undefined; setRunning(false); onRunningChange(false) }
  }
  const controls = slots.find(slot => slot.report)?.report?.controls
  return <section className="bench-controls bench-parallel" aria-label="Skill and creative variety study">
    <h2>Skill and creative variety</h2>
    <p>Independent deterministic alpha-beta reference. Eight repeats of identical prompts, then eight production-order permutations on eight free-choice positions and tactical controls. Skill and quality-preserving variety are separate 0–100 scores.</p>
    <fieldset disabled={disabled || running}><legend>Models · production defaults, thinking off</legend><div className="bench-parallel-models">{options.filter(option => option.thinking !== "required").map(option => <label key={option.id}><input type="checkbox" checked={models.includes(option.id)} onChange={event => setSelected(event.currentTarget.checked ? [...models, option.id] : models.filter(id => id !== option.id))} />{option.label}</label>)}</div></fieldset>
    <div className="bench-actions"><button type="button" disabled={disabled || running || !models.length} onClick={() => { void start() }}>Run skill and variety study</button><button type="button" disabled={!running} onClick={() => controller.current?.abort()}>Stop behavior study</button><button type="button" disabled={running || !slots.some(slot => slot.report)} onClick={() => setShowJson(previous => !previous)}>Behavior report JSON</button></div>
    <p role="status">{running ? "Behavior studies are running in this tab. Timings include concurrent work." : slots.length ? "Behavior study finished." : "No inference starts until Run is pressed. Short trajectories are capped and are not full-game win rates."}</p>
    <div className="bench-parallel-table"><table aria-label="Behavior scores"><thead><tr><th>Model</th><th>Probe skill</th><th>Free-choice repeatability</th><th>Fixed safe variety</th><th>Seeded safe variety</th><th>Capped-game quality</th><th>Status</th></tr></thead><tbody>{slots.map(slot => <tr key={slot.model}><td>{options.find(option => option.id === slot.model)?.label ?? slot.model}</td><td>{score(slot.report?.summary.skillScore)}</td><td>{score(slot.report?.summary.conditions.fixed.freeChoiceRepeatability)}</td><td>{score(slot.report?.summary.conditions.fixed.safeVariety)}</td><td>{score(slot.report?.summary.conditions["game-seeded"].safeVariety)}</td><td>{trajectoryQuality(slot.report)}</td><td>{slot.error ?? slot.status}</td></tr>)}{controls && Object.entries(controls).map(([name, summary]) => <tr key={name}><td>{name === "canonical-engine" ? "Deterministic alpha-beta (4 ply)" : name === "near-best-random" ? "Near-best random · control" : "Legal random · control"}</td><td>{score(summary.skillScore)}</td><td>{score(summary.conditions.fixed.freeChoiceRepeatability)}</td><td>{score(summary.conditions.fixed.safeVariety)}</td><td>{score(summary.conditions["game-seeded"].safeVariety)}</td><td>—</td><td>Reference control</td></tr>)}</tbody></table></div>
    <p>Probe skill combines tactical-suite accuracy and reference acceptance. Capped-game quality counts nonforced AI choices within 25 reference points of best (a piece is 100); games stop at 20 plies. Variety counts reference-acceptable successor states, not random mistakes. Near-best-random and uniform-random controls show the score’s limits. Human-likeness and emergence are not established by this test.</p>
    {showJson && <pre id="behavior-benchmark-json">{JSON.stringify({ schemaVersion: 1, studies: slots.map(slot => ({ model: slot.model, status: slot.status, error: slot.error, report: slot.report })) }, null, 2)}</pre>}
  </section>
}
