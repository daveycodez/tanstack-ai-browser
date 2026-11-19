/**
 * The tool-calling tests, run inside an app's page where the afm adapter's
 * native side is (Lofi Agent's Capacitor app on an iPhone or iPad, its
 * Electron window on a Mac) by run.mjs. Each case runs through TanStack's
 * `chat()`, which calls the tools (tools.ts) as an app's would, each turn
 * after the earlier turns' messages, calls and results included. Lines go to
 * `globalThis.__afmToolTests.lines` for run.mjs to read.
 *
 * Query: `runs` (each case's, 3 by default), `cases` (names or groups, all
 * by default), `system=none` (no system prompt; Lofi Agent's former default
 * otherwise).
 */
import { chat } from "@tanstack/ai"
import type { ModelMessage } from "@tanstack/ai"

import { afmText } from "../src/index.js"
import type { Case, Turn } from "./cases.js"
import { CASES } from "./cases.js"
import { makeTools } from "./tools.js"

/** Lofi Agent's default system prompt: says when to reply directly, nothing about any tool. */
const SYSTEM_PROMPT =
  "You are a helpful assistant in a conversation with a person. Reply directly when you can. Use a tool only when the person asks for something you cannot answer without it. When a tool gives you its result, use it to answer."

const TURN_MS = 120_000

const state: { lines: Array<string> } = { lines: [] }
;(globalThis as { __afmToolTests?: typeof state }).__afmToolTests = state
const log = (line: string) => {
  state.lines.push(line)
  console.log(`[afm-tools] ${line}`)
}

type Chunk = { type: string; [key: string]: unknown }

/** One turn through `chat()`: what it called and answered, and the messages it adds to the conversation. */
type Adapter = ReturnType<typeof afmText>

async function turn(adapter: Adapter, threadId: string, history: Array<ModelMessage>, prompt: string, system: Array<string>, only?: Array<string>) {
  const all = makeTools().tools
  const tools = only ? all.filter((tool) => only.includes(tool.name)) : all
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(new Error(`no answer in ${TURN_MS / 1000} s`)), TURN_MS)
  // The turn's steps, as the conversation keeps them: each step's text and calls, then the calls' results.
  type Step = { text: string; calls: Array<{ id: string; name: string; args: string; input: unknown; result?: string; failed?: boolean }> }
  const steps: Array<Step> = [{ text: "", calls: [] }]
  const current = () => steps[steps.length - 1]!
  const done = (step: Step) => step.calls.length > 0 && step.calls.every((call) => call.result !== undefined)
  let error: string | undefined
  const names = new Map<string, string>()
  const messages: Array<ModelMessage> = [...history, { role: "user", content: prompt }]
  try {
    for await (const raw of chat({ adapter, threadId, messages, tools, systemPrompts: system, abortController })) {
      const chunk = raw as Chunk
      if (chunk.type === "TEXT_MESSAGE_CONTENT") {
        if (done(current())) steps.push({ text: "", calls: [] })
        current().text += String(chunk.delta ?? "")
      } else if (chunk.type === "TOOL_CALL_START") {
        // The call's name: chat()'s TOOL_CALL_END doesn't repeat it.
        names.set(String(chunk.toolCallId), String(chunk.toolCallName))
      } else if (chunk.type === "TOOL_CALL_END") {
        if (done(current())) steps.push({ text: "", calls: [] })
        const id = String(chunk.toolCallId)
        current().calls.push({ id, name: names.get(id) ?? String(chunk.toolCallName), args: JSON.stringify(chunk.input ?? {}), input: chunk.input ?? {} })
      } else if (chunk.type === "TOOL_CALL_RESULT") {
        const call = steps.flatMap((step) => step.calls).find((c) => c.id === chunk.toolCallId)
        if (call) {
          call.result = typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content)
          // A call chat() rejected (arguments that don't fit the schema) or whose tool threw.
          call.failed = (chunk.metadata as { tanstack?: { state?: string } } | undefined)?.tanstack?.state === "output-error"
        }
      } else if (chunk.type === "RUN_ERROR") {
        error = String((chunk.error as { message?: string } | undefined)?.message ?? chunk.message ?? "run error")
      }
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    clearTimeout(timer)
  }
  const added: Array<ModelMessage> = [{ role: "user", content: prompt }]
  for (const step of steps) {
    if (step.calls.length === 0) {
      if (step.text) added.push({ role: "assistant", content: step.text })
      continue
    }
    added.push({ role: "assistant", content: step.text, toolCalls: step.calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })) })
    for (const c of step.calls) added.push({ role: "tool", toolCallId: c.id, content: c.result ?? "" })
  }
  const text = steps.at(-1)?.calls.length ? "" : (steps.at(-1)?.text ?? "")
  // Every call the model made, as it made it: run, rejected or failed.
  const calls = steps.flatMap((step) => step.calls).map((c) => {
    let result: unknown = c.result
    try {
      result = JSON.parse(c.result ?? "")
    } catch {
      // Text.
    }
    return { name: c.name, args: (c.input ?? {}) as Record<string, unknown>, result, ...(c.failed && { error: String(c.result) }) }
  })
  const result: Turn = { calls, text, ...(error && { error }) }
  return { result, added }
}

/** A turn as one line: its calls with their arguments, then its answer. */
const describe = (t: Turn) =>
  [...t.calls.map((c) => `${c.name} ${JSON.stringify(c.args)}${c.error ? ` (failed: ${c.error.slice(0, 120)})` : ""}`), t.error ? `error: ${t.error}` : `text: ${t.text.replace(/\s+/g, " ").slice(0, 160)}`].join(" > ")

async function runCase(adapter: Adapter, test: Case, run: number, system: Array<string>) {
  const threadId = `afm-tools-${test.name}-${run}-${Date.now().toString(36)}`
  let history: Array<ModelMessage> = []
  const parts: Array<string> = []
  const started = performance.now()
  let failed: string | undefined
  for (const [index, step] of test.turns.entries()) {
    const { result, added } = await turn(adapter, threadId, history, step.prompt, system, test.tools)
    history = [...history, ...added]
    parts.push(`${test.turns.length > 1 ? `turn ${index + 1}: ` : ""}${describe(result)}`)
    failed = step.check(result)
    if (failed) {
      failed = `${test.turns.length > 1 ? `turn ${index + 1}: ` : ""}${failed}`
      break
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  log(`CASE ${test.name} run ${run}: ${failed ? "FAIL" : "PASS"} ${seconds}s${failed ? ` (${failed})` : ""} || ${parts.join(" || ")}`)
  return !failed
}

async function main() {
  const query = new URLSearchParams((globalThis as { __afmToolTestsQuery?: string }).__afmToolTestsQuery ?? "")
  const runs = Number(query.get("runs") ?? 3)
  const wanted = query.get("cases")?.split(",").filter(Boolean)
  const cases = wanted ? CASES.filter((c) => wanted.includes(c.name) || wanted.includes(c.group)) : CASES
  const system = query.get("system") === "none" ? [] : [SYSTEM_PROMPT]
  const adapter: Adapter = afmText()
  try {
    await adapter.create()
  } catch (error) {
    log(`ERROR ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const label = (await adapter.variant())?.displayName ?? "Apple's on-device model"
  log(`MODEL ${label}${system.length ? "" : ", no system prompt"}`)
  const tally = new Map<string, { passed: number; total: number }>()
  for (const test of cases) {
    for (let run = 1; run <= runs; run++) {
      const passed = await runCase(adapter, test, run, system)
      for (const key of [test.group, "all"]) {
        const t = tally.get(key) ?? { passed: 0, total: 0 }
        t.total += 1
        if (passed) t.passed += 1
        tally.set(key, t)
      }
    }
  }
  log(`SUMMARY ${JSON.stringify(Object.fromEntries(tally))}`)
  await adapter.destroy()
  log("ALL DONE")
}

main().catch((error) => log(`ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`))
