/**
 * The tool-calling eval, for any TanStack AI text adapter: seven prompts,
 * each run `runs` times (4 by default: 28 cases), with the tools of three
 * real MCP servers (Exa's search, the MCP Time server, a calculator:
 * tools.json) and no system prompt. A case passes when the model calls a
 * tool where it should and answers in text where it shouldn't; for a call,
 * the step after it (the call and its tool's result in the chat) must answer
 * from that result. Each thread is its own conversation, as `chat()` keeps
 * one.
 */
import type { ModelMessage, Tool } from "@tanstack/ai"

import tools from "./tools.json"

type Step = { kind: "text"; text: string } | { kind: "tool"; tool: string; call: { id: string; name: string; input: unknown }; text: string } | { kind: "error"; text: string }

/** The tools' results for the step after a call. */
const RESULTS: Record<string, string> = {
  web_search_exa:
    "Title: 2026 World Series results\nPublished: 2026-11-02\nHighlights: The Portland Pioneers won the 2026 World Series, beating the Atlanta Braves 4 games to 2.",
  get_current_time: JSON.stringify({ timezone: "Asia/Tokyo", datetime: "2026-11-16T09:52:00+09:00", day_of_week: "Monday", is_dst: false }),
  convert_time: JSON.stringify({
    source: { timezone: "America/Los_Angeles", datetime: "2026-11-15T16:52:00-08:00" },
    target: { timezone: "Asia/Tokyo", datetime: "2026-11-16T09:52:00+09:00" },
    time_difference: "+17.0h"
  }),
  calculate: "391"
}

const GREETING: Array<ModelMessage> = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello! How can I help you today?" }
]
const TOLD: Array<ModelMessage> = [
  { role: "user", content: "Write me a short story" },
  {
    role: "assistant",
    content:
      "Once upon a time, in a quiet harbor town, a lighthouse keeper named Mara found a glass bottle with a map inside. She followed it across the cliffs to a hidden cove, where an old rowboat waited with her grandfather's name carved into its side. Inside lay a letter he had written decades ago, telling her the light she kept had guided him home every night. Mara rowed back at dusk, lit the lamp, and for the first time understood why it mattered."
  }
]

/** A story: text, not a refusal. */
const story = (r: Step) =>
  r.kind === "text" &&
  r.text.trim().length > 0 &&
  !/\b(I can(?:no|')t|I am (?:unable|not able)|I'm (?:unable|not able)|I am sorry|I'm sorry)\b/i.test(r.text.slice(0, 200))
const called = (r: Step, ...names: Array<string>) => r.kind === "tool" && names.includes(r.tool)
const answered = (pattern: RegExp) => (r: Step) => r.kind === "text" && pattern.test(r.text)

type Case = { name: string; prompt: string; history: Array<ModelMessage>; pass: (r: Step) => boolean; then?: (r: Step) => boolean }

const CASES: Array<Case> = [
  { name: "hello", prompt: "Hello", history: [], pass: (r) => r.kind === "text" },
  { name: "story", prompt: "Write me a short story about a space adventure", history: [], pass: story },
  { name: "story-after-greeting", prompt: "Write me a short story about a space adventure", history: GREETING, pass: story },
  { name: "world-series", prompt: "Who won the most recent World Series?", history: [], pass: (r) => called(r, "web_search_exa"), then: answered(/Portland Pioneers/i) },
  { name: "time", prompt: "What time is it in Tokyo?", history: [], pass: (r) => called(r, "get_current_time", "convert_time"), then: answered(/9:52|09:52/) },
  {
    name: "world-series-after-story",
    prompt: "Who won the most recent World Series?",
    history: TOLD,
    pass: (r) => called(r, "web_search_exa"),
    then: answered(/Portland Pioneers/i)
  },
  // 391, from `calculate` or straight away: the call is optional.
  {
    name: "math-after-greeting",
    prompt: "What's 17 times 23?",
    history: GREETING,
    pass: (r) => called(r, "calculate") || answered(/391/)(r),
    then: answered(/391/)
  }
]

/** The adapter's side the suite uses: TanStack's `chatStream`, as `chat()` calls it. */
export type EvalAdapter = { model: string; chatStream(options: unknown): AsyncIterable<unknown> }

export const CASE_NAMES = CASES.map((c) => c.name)

const noop = () => undefined
const logger = new Proxy({}, { get: () => noop }) as never

/**
 * Runs the suite on `adapter`, writing each case's line (`CASE …`) and a
 * `SUMMARY {json}` with `log`. `cases` limits it to some of them.
 */
export async function runSuite(
  adapter: EvalAdapter,
  options: {
    runs?: number
    cases?: Array<string>
    label: string
    log: (line: string) => void
    /** A step's limit: past it the case fails as a timeout (2 minutes by default). */
    stepMs?: number
    /** Options added to every request (`reasoning`, `modelOptions`, `systemPrompts`, …): no system prompt unless given here. */
    request?: Record<string, unknown>
  }
) {
  const { runs = 4, log, label, stepMs = 120_000, request } = options
  const cases = options.cases ? CASES.filter((c) => options.cases!.includes(c.name)) : CASES

  const step = async (threadId: string, messages: Array<ModelMessage>): Promise<Step> => {
    let text = ""
    let call: { id: string; name: string; input: unknown } | undefined
    // A step that hangs (a browser's model can) fails the case rather than the run.
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(new Error("timeout")), stepMs)
    try {
      for await (const e of adapter.chatStream({ systemPrompts: [], ...request, model: adapter.model, messages, tools: tools as Array<Tool>, logger, threadId, runId: `run${Math.random()}`, abortController })) {
        const event = e as { type: string; delta?: string; toolCallId?: string; toolCallName?: string; input?: unknown; message?: string; error?: { message?: string } }
        if (event.type === "TEXT_MESSAGE_CONTENT") text += event.delta ?? ""
        if (event.type === "TOOL_CALL_END") call = { id: event.toolCallId!, name: event.toolCallName!, input: event.input }
        if (event.type === "RUN_ERROR") return { kind: "error", text: abortController.signal.aborted ? `timeout after ${stepMs / 1000} s` : (event.error?.message ?? event.message ?? "error") }
      }
    } catch (error) {
      if (abortController.signal.aborted) return { kind: "error", text: `timeout after ${stepMs / 1000} s` }
      throw error
    } finally {
      clearTimeout(timer)
    }
    return call ? { kind: "tool", tool: call.name, call, text } : { kind: "text", text }
  }

  const once = async (c: Case) => {
    const threadId = `eval${Math.random()}`
    const messages: Array<ModelMessage> = [...c.history, { role: "user", content: c.prompt }]
    const first = await step(threadId, messages)
    if (!c.then || !c.pass(first) || first.kind !== "tool") return { first }
    const { id, name, input } = first.call
    const second = await step(threadId, [
      ...messages,
      { role: "assistant", content: first.text, toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input ?? {}) } }] },
      { role: "tool", toolCallId: id, content: RESULTS[name] ?? "" }
    ])
    return { first, second }
  }

  const brief = (r: Step) => (r.kind === "tool" ? `tool:${r.tool} ${JSON.stringify(r.call.input)}` : `${r.kind}:${r.text.slice(0, 80).replace(/\s+/g, " ")}`)
  /** Each case's passes, runs and seconds (both steps, summed over its runs). */
  const score: Record<string, { passed: number; n: number; seconds: number }> = {}
  let passed = 0
  let seconds = 0
  for (let run = 1; run <= runs; run++) {
    for (const c of cases) {
      let first: Step
      let second: Step | undefined
      const start = performance.now()
      try {
        ;({ first, second } = await once(c))
      } catch (error) {
        first = { kind: "error", text: String((error as Error)?.message ?? error) }
      }
      const took = (performance.now() - start) / 1000
      // A call must be followed by an answer from its result; an answer in text stands on its own.
      const ok = c.pass(first) && (!c.then || first.kind !== "tool" || (second !== undefined && c.then(second)))
      const s = (score[c.name] ??= { passed: 0, n: 0, seconds: 0 })
      s.n++
      s.seconds = Math.round((s.seconds + took) * 10) / 10
      seconds += took
      if (ok) {
        s.passed++
        passed++
      }
      log(`CASE ${c.name} run ${run}: ${ok ? "PASS" : "FAIL"} ${took.toFixed(1)}s || ${brief(first)}${second ? ` || ${brief(second)}` : ""}`)
    }
  }
  const summary = { model: label, passed, total: runs * cases.length, seconds: Math.round(seconds * 10) / 10, cases: score }
  log(`SUMMARY ${JSON.stringify(summary)}`)
  return summary
}
