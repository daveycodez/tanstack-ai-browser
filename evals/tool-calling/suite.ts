/**
 * The tool-calling eval, for any TanStack AI text adapter: seven prompts,
 * each run `runs` times (4 by default: 28 cases), with the tools of three
 * real MCP servers (Exa's search, the MCP Time server, a calculator:
 * tools.json) and no system prompt unless one is given.
 *
 * A case runs as `chat()` would run it: the model's tool calls get their
 * results and it goes on, until it answers in text (or `maxSteps`). Exa's
 * tools return Exa's own recorded answers (exa.json), the time tools and the
 * calculator fixed results in their servers' own shapes: every model reads
 * the same results, in the real format, and the checks know the answer. A case passes when the model answers in text
 * where no tool is needed, and where one is, calls it and answers from what
 * it returned. Each thread is its own conversation, as `chat()` keeps one.
 */
import type { ModelMessage, Tool } from "@tanstack/ai"

import exa from "./exa.json"
import lofiAgentTools from "./tools-lofi-agent.json"
import mcpTools from "./tools.json"

type Step = { kind: "text"; text: string } | { kind: "tool"; tool: string; call: { id: string; name: string; input: unknown }; text: string } | { kind: "error"; text: string }

/** The time tools' and the calculator's results, fixed, in their servers' own shapes. */
const FIXED: Record<string, string> = {
  get_current_time: JSON.stringify({ timezone: "Asia/Tokyo", datetime: "2026-11-16T09:52:00+09:00", day_of_week: "Monday", is_dst: false }),
  convert_time: JSON.stringify({
    source: { timezone: "America/Los_Angeles", datetime: "2026-11-15T16:52:00-08:00" },
    target: { timezone: "Asia/Tokyo", datetime: "2026-11-16T09:52:00+09:00" },
    time_difference: "+17.0h"
  }),
  get_time_ago: JSON.stringify({ timezone: "Asia/Tokyo", datetime: "2026-11-15T09:52:00+09:00", day_of_week: "Sunday", is_dst: false }),
  calculate: "391"
}

/** web_search_exa's results as Exa separates them. */
const RESULTS = exa.search.split("\n\n---\n\n")
const PAGES: Record<string, string> = exa.pages

/** A URL as written in the search results, whatever its trailing slash or "www.". */
const plain = (url: string) => url.trim().replace(/\/+$/, "").replace(/^(https?:\/\/)www\./, "$1")

/**
 * Exa's tools, answered from exa.json: Exa's own answers (see its note), in
 * Exa's format, so every model reads the same thing and no run calls Exa.
 * Any search gets the recorded results, as many as it asks for; a fetch gets
 * the pages of the URLs it names that are among them, cut at
 * `maxCharacters` (3,000 by default, as Exa's), or Exa's error where none is.
 */
function exaTool(name: string, input: unknown): string {
  const args = (input ?? {}) as { numResults?: unknown; urls?: unknown; maxCharacters?: unknown }
  if (name === "web_search_exa") {
    const count = Number(args.numResults)
    return RESULTS.slice(0, count > 0 ? count : RESULTS.length).join("\n\n---\n\n")
  }
  const urls = Array.isArray(args.urls) ? args.urls.map(String) : []
  const limit = Number(args.maxCharacters) > 0 ? Number(args.maxCharacters) : 3000
  const known = Object.keys(PAGES)
  const found = urls.flatMap((url) => known.filter((k) => plain(k) === plain(url)).slice(0, 1))
  if (found.length === 0) return exa.missing.replace("{urls}", urls.join(", "))
  return found
    .map((url) => {
      const page = PAGES[url]!
      const body = page.indexOf("\n\n") + 2
      return page.slice(0, body + limit)
    })
    .join("\n\n")
}

/** A tool call's result: Exa's recorded answers, the others' fixed ones. */
const toolResult = (name: string, input: unknown) => (name.endsWith("_exa") ? exaTool(name, input) : (FIXED[name] ?? `Error: no tool named ${name}`))

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

/** A story: a few paragraphs at least (400 characters), and not a refusal to write one. */
const story = (text: string) => {
  const plain = text.replace(/\u2019/g, "'")
  return plain.trim().length >= 400 && !/\b(I can(?:no|')t|I am (?:unable|not able)|I'm (?:unable|not able)|I am sorry|I'm sorry)\b/i.test(plain.slice(0, 200))
}

/**
 * A case: its prompt after `history`, and what passes. With `tools`, the
 * model must call one of them (unless `optional`) and its answer must match
 * `answer`; without, it must answer in text straight away, and `answer`
 * checks that text.
 */
type Case = {
  name: string
  prompt: string
  history: Array<ModelMessage>
  tools?: Array<string>
  optional?: boolean
  answer?: RegExp | ((text: string) => boolean)
}

/** The 2026 World Series (it ended on October 28, 2026): what the recorded search says. */
const WORLD_SERIES = /Brewers/i

const CASES: Array<Case> = [
  { name: "hello", prompt: "Hello", history: [] },
  { name: "story", prompt: "Write me a short story about a space adventure", history: [], answer: story },
  { name: "story-after-greeting", prompt: "Write me a short story about a space adventure", history: GREETING, answer: story },
  { name: "world-series", prompt: "Who won the World Series in 2026?", history: [], tools: ["web_search_exa"], answer: WORLD_SERIES },
  { name: "time", prompt: "What time is it in Tokyo?", history: [], tools: ["get_current_time", "convert_time"], answer: /9:52|09:52/ },
  { name: "world-series-after-story", prompt: "Who won the World Series in 2026?", history: TOLD, tools: ["web_search_exa"], answer: WORLD_SERIES },
  // 391, from `calculate` or straight away: the call is optional.
  { name: "math-after-greeting", prompt: "What's 17 times 23?", history: GREETING, tools: ["calculate"], optional: true, answer: /391/ }
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
    /** The tools offered: the three MCP servers' (tools.json, the default), or Lofi Agent's own list (tools-lofi-agent.json). */
    tools?: "mcp" | "lofi-agent"
    /** Most replies of the model in a case, tool calls included (6 by default): past it the case fails. */
    maxSteps?: number
    /** Options added to every request (`reasoning`, `modelOptions`, `systemPrompts`, …): no system prompt unless given here. */
    request?: Record<string, unknown>
  }
) {
  const { runs = 4, log, label, stepMs = 120_000, maxSteps = 6, request } = options
  const tools = options.tools === "lofi-agent" ? lofiAgentTools : mcpTools
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

  /** A case as `chat()` runs it: each tool call gets its result, until the model answers in text. */
  const once = async (c: Case): Promise<Array<Step>> => {
    const threadId = `eval${Math.random()}`
    const messages: Array<ModelMessage> = [...c.history, { role: "user", content: c.prompt }]
    const steps: Array<Step> = []
    while (steps.length < maxSteps) {
      const reply = await step(threadId, messages)
      steps.push(reply)
      // A call where no tool is needed already fails the case: its tool isn't run.
      if (reply.kind !== "tool" || !c.tools) break
      const { id, name, input } = reply.call
      messages.push(
        { role: "assistant", content: reply.text, toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input ?? {}) } }] },
        { role: "tool", toolCallId: id, content: toolResult(name, input) }
      )
    }
    return steps
  }

  const matches = (c: Case, text: string) => (typeof c.answer === "function" ? c.answer(text) : (c.answer?.test(text) ?? true))
  const passes = (c: Case, steps: Array<Step>) => {
    const last = steps.at(-1)
    if (last?.kind !== "text" || !matches(c, last.text)) return false
    if (!c.tools) return steps.length === 1
    return c.optional || steps.some((reply) => reply.kind === "tool" && c.tools!.includes(reply.tool))
  }

  const brief = (r: Step) => (r.kind === "tool" ? `tool:${r.tool} ${JSON.stringify(r.call.input)}` : `${r.kind}:${r.text.slice(0, 120).replace(/\s+/g, " ")}`)
  /** Each case's passes, runs and seconds (every step, summed over its runs). */
  const score: Record<string, { passed: number; n: number; seconds: number }> = {}
  let passed = 0
  let seconds = 0
  for (let run = 1; run <= runs; run++) {
    for (const c of cases) {
      let steps: Array<Step>
      const start = performance.now()
      try {
        steps = await once(c)
      } catch (error) {
        steps = [{ kind: "error", text: String((error as Error)?.message ?? error) }]
      }
      const took = (performance.now() - start) / 1000
      const ok = passes(c, steps)
      const s = (score[c.name] ??= { passed: 0, n: 0, seconds: 0 })
      s.n++
      s.seconds = Math.round((s.seconds + took) * 10) / 10
      seconds += took
      if (ok) {
        s.passed++
        passed++
      }
      log(`CASE ${c.name} run ${run}: ${ok ? "PASS" : "FAIL"} ${took.toFixed(1)}s || ${steps.map(brief).join(" || ")}`)
    }
  }
  const summary = { model: label, passed, total: runs * cases.length, seconds: Math.round(seconds * 10) / 10, cases: score }
  log(`SUMMARY ${JSON.stringify(summary)}`)
  return summary
}
