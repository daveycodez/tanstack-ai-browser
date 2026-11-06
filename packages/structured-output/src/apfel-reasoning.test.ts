import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/structured-output/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "apfel-reasoning-contract-"))
after(() => rm(temporary, { recursive: true, force: true }))
const outfile = join(temporary, "adapter.mjs")
await build({ stdin: { contents: `export * from '${root}/packages/apfel/src/index.ts';export {chat} from '@tanstack/ai';`, resolveDir: join(root, "packages/apfel") }, outfile, bundle: true, format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error" })
const { apfelText, chat } = await import(pathToFileURL(outfile).href)
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"], additionalProperties: false }
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
type RequestBody = { model: string; stream?: boolean; max_tokens?: number; temperature?: number; seed?: number; reasoning?: unknown; tools?: unknown; tool_choice?: string; response_format?: unknown; messages: Array<{ role: string; content: string }> }
const state = { requests: [] as Array<{ url: string; body: RequestBody; init: RequestInit }>, tools: false, draftFinish: "length", draftTokens: 4, finalFinish: "stop", draftFailure: false, abortDraft: false, abortFinal: false, controller: new AbortController() }
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
function stream(draft: boolean, structured = false) {
  const chunks = draft
    ? [{ choices: [{ delta: { content: "working " } }] }, { choices: [{ delta: { content: "notes" }, finish_reason: state.draftFinish }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: state.draftTokens } }]
    : [{ choices: [{ delta: state.tools ? { tool_calls: [{ index: 0, id: "call_1", function: { name: "ping", arguments: "{}" } }] } : { content: structured ? '{"moveId":"b6-a5"}' : "final answer" }, finish_reason: state.tools ? "tool_calls" : structured ? state.finalFinish : "stop" }] }, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 3 } }]
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (draft && state.abortDraft && index === 1) state.controller.abort(new Error("cancel during draft"))
    if (index < chunks.length) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunks[index++])}\n\n`))
    else { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close() }
  } }, { highWaterMark: 0 }))
}
function reset() {
  state.requests = []; state.tools = false; state.draftFinish = "length"; state.draftTokens = 4; state.finalFinish = "stop"; state.draftFailure = false; state.abortDraft = false; state.abortFinal = false; state.controller = new AbortController()
  globalThis.fetch = async (url, init = {}) => {
    init.signal?.throwIfAborted()
    const body = JSON.parse(String(init.body)) as RequestBody
    state.requests.push({ url: String(url), body, init })
    const draft = body.messages.at(-1)?.content.includes("Write short working notes") === true
    if (draft && state.draftFailure) return new Response("draft failed", { status: 503 })
    if (!draft && state.abortFinal) state.controller.abort(new Error("cancel during final"))
    if (body.stream) return stream(draft, body.response_format !== undefined)
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"moveId":"b6-a5"}' }, finish_reason: state.finalFinish }], usage: { prompt_tokens: 30, completion_tokens: 3 } }))
  }
}
function options(reasoning?: unknown, modelOptions?: object, requestSignal = true) {
  return { chatOptions: { logger, threadId: "apfel-reasoning-test", model: "apple-foundationmodel", messages: [{ role: "user", content: "Choose a legal move" }], ...(reasoning === undefined ? {} : { reasoning }), ...(modelOptions && { modelOptions }), ...(requestSignal ? { request: { signal: state.controller.signal } } : { abortController: state.controller }) }, outputSchema: schema }
}
async function collect(source: AsyncIterable<Record<string, unknown>>) { const events = []; for await (const event of source) events.push(event); return events }

test("Apfel off/omitted remains one pass with model defaults and exact schema", async () => {
  for (const reason of [undefined, { level: "off", budgetTokens: 512 }]) {
    reset(); const result = await apfelText("apple-foundationmodel").structuredOutput(options(reason))
    assert.deepEqual(result.data, { moveId: "b6-a5" })
    assert.equal(state.requests.length, 1)
    assert.equal(state.requests[0].body.max_tokens, undefined)
    assert.equal(state.requests[0].body.reasoning, undefined)
    assert.deepEqual(state.requests[0].body.response_format, { type: "json_schema", json_schema: { name: "output", schema } })
    assert.equal(result.usage.providerUsageDetails, undefined)
  }
})

test("Apfel high caps only draft, preserves final settings, schema and caller history", async () => {
  reset()
  const input = options({ level: "high", budgetTokens: 4 }, { maxCompletionTokens: 8192, temperature: 0.7, seed: 42 })
  const original = JSON.stringify(input.chatOptions.messages)
  const adapter = apfelText("apple-foundationmodel", { baseURL: "http://local.invalid/v1/", defaultHeaders: { "x-test": "yes" } })
  const events = await collect(adapter.structuredOutputStream(input))
  const notes = events.filter(e => e.type === "REASONING_MESSAGE_CONTENT").map(e => e.delta).join("")
  const complete = events.find(e => e.type === "CUSTOM" && e.name === "structured-output.complete") as { value: { object: unknown; reasoning?: string } } | undefined
  const finished = events.find(e => e.type === "RUN_FINISHED") as { usage: { promptTokens: number; completionTokens: number; completionTokensDetails: { reasoningTokens: number }; providerUsageDetails: Record<string, unknown> } } | undefined
  assert.ok(complete && finished)
  assert.deepEqual(complete.value.object, { moveId: "b6-a5" }); assert.equal(complete.value.reasoning, "working notes")
  const result = finished
  assert.equal(state.requests.length, 2)
  const [draft, final] = state.requests
  assert.equal(draft.url, "http://local.invalid/v1/chat/completions")
  assert.equal((draft.init.headers as Record<string, string>)["x-test"], "yes")
  assert.equal(draft.body.max_tokens, 4); assert.equal(final.body.max_tokens, 8192)
  assert.equal(draft.body.tools, undefined); assert.equal(draft.body.response_format, undefined)
  assert.equal(final.body.temperature, 0.7); assert.equal(draft.body.temperature, 0.7)
  assert.equal(final.body.seed, 42)
  assert.deepEqual(final.body.response_format, { type: "json_schema", json_schema: { name: "output", schema } })
  assert.equal(final.init.signal, state.controller.signal)
  assert.ok(draft.init.signal?.aborted, "draft transport is closed independently")
  assert.equal(state.controller.signal.aborted, false)
  assert.equal(notes, "working notes"); assert.match(final.body.messages.at(-1)?.content ?? "", /working notes/)
  assert.ok(events.findIndex(e => e.type === "REASONING_END") < events.findIndex(e => e.type === "TEXT_MESSAGE_START"), "reasoning precedes the JSON")
  assert.equal(JSON.stringify(input.chatOptions.messages), original)
  assert.equal(result.usage.promptTokens, 50); assert.equal(result.usage.completionTokens, 7)
  assert.equal(result.usage.completionTokensDetails.reasoningTokens, 4)
  assert.equal(result.usage.providerUsageDetails.reasoningEmulated, true)
  assert.equal(result.usage.providerUsageDetails.reasoningBudgetEnforcement, "server-output-limit")
  assert.equal(result.usage.providerUsageDetails.thinkingBudgetExhausted, true)
})

test("Apfel high without a budget invents no cap; explicit smaller caller cap is preserved", async () => {
  reset(); await apfelText("apple").structuredOutput(options({ level: "high" }))
  assert.ok(state.requests.every(r => r.body.max_tokens === undefined))
  reset(); const result = await apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 512 }, { maxCompletionTokens: 16 }))
  assert.deepEqual(state.requests.map(r => r.body.max_tokens), [16, 16])
  assert.equal(result.usage.providerUsageDetails.thinkingOutputLimitTokens, 16)
  assert.equal(result.usage.providerUsageDetails.thinkingBudgetExhausted, false)
})

test("Apfel zero budget skips draft and negative or invalid budgets fail before requests", async () => {
  reset(); const result = await apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 0 }))
  assert.equal(state.requests.length, 1); assert.equal(result.usage.providerUsageDetails.thinkingTokens, 0)
  for (const budgetTokens of [-1, 1.5, Infinity, NaN]) {
    reset(); await assert.rejects(apfelText("apple").structuredOutput(options({ level: "high", budgetTokens })), /budgetTokens/)
    assert.equal(state.requests.length, 0)
  }
})

test("Apfel emits reasoning before final text and preserves tool selection and calls", async () => {
  for (const tools of [false, true]) {
    reset(); state.tools = tools
    const base = options({ level: "high", budgetTokens: 4 }).chatOptions
    const events = await collect(apfelText("apple").chatStream({ ...base, tools: tools ? [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] : [], toolChoice: tools ? "required" : "none" }))
    assert.equal(state.requests[0].body.tools, undefined)
    assert.ok(events.some(e => e.type === "REASONING_MESSAGE_CONTENT" && e.delta === "working "))
    if (tools) {
      assert.equal(state.requests[1].body.tool_choice, "required")
      const calls = events.filter(e => e.type === "TOOL_CALL_END")
      assert.equal(calls.length, 1); assert.equal(calls[0].toolCallName, "ping")
    } else {
      const endReason = events.findIndex(e => e.type === "REASONING_END")
      assert.ok(endReason < events.findIndex(e => e.type === "TEXT_MESSAGE_START"))
    }
    const finish = events.find(e => e.type === "RUN_FINISHED")
    assert.ok(finish); assert.equal((finish.usage as { completionTokens: number }).completionTokens, 7)
  }
})

test("Apfel request.signal and legacy abortController cancel before, during draft and final", async () => {
  for (const requestSignal of [true, false]) {
    reset(); state.controller.abort(new Error("cancel before"))
    await assert.rejects(apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 4 }, undefined, requestSignal)), /cancel before/)
    assert.equal(state.requests.length, 0)
    reset(); state.abortDraft = true
    await assert.rejects(apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 4 }, undefined, requestSignal)), /cancel during draft/)
    assert.equal(state.requests.length, 1); assert.ok(state.requests[0].init.signal?.aborted)
    reset(); state.abortFinal = true
    await assert.rejects(apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 4 }, undefined, requestSignal)), /cancel during final/)
    assert.equal(state.requests.length, 2)
  }
})

test("Apfel draft errors do not silently generate a final answer or retry", async () => {
  reset(); state.draftFailure = true
  await assert.rejects(apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 4 })), /reach apfel|503/)
  assert.equal(state.requests.length, 1)
  reset(); state.finalFinish = "length"
  await assert.rejects(apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 4 })), /cut off/)
  assert.equal(state.requests.length, 2)
})

test("Apfel stopping a reasoning stream closes the draft and never starts the final", async () => {
  reset(); const source = apfelText("apple").chatStream(options({ level: "high", budgetTokens: 4 }).chatOptions)
  for await (const event of source) if (event.type === "REASONING_MESSAGE_CONTENT") break
  assert.equal(state.requests.length, 1); assert.equal(state.controller.signal.aborted, false)
  assert.ok(state.requests[0].init.signal?.aborted)
})

test("TanStack chat forwards Apfel high/off reasoning through structured finalization", async () => {
  for (const reasoning of ["off", { level: "high", budgetTokens: 4 }]) {
    reset()
    const result = await chat({ adapter: apfelText("apple"), threadId: "public-apfel", messages: [{ role: "user", content: "Choose a move" }], reasoning, outputSchema: schema, stream: false, abortController: state.controller })
    assert.deepEqual(result, { moveId: "b6-a5" })
    assert.equal(state.requests.length, reasoning === "off" ? 1 : 2)
  }
})


test("Apfel draft notes preserve the original user turn and authoritative tool-result ordering", async () => {
  reset()
  const request = options({ level: "high", budgetTokens: 4 }).chatOptions
  const messages = [
    { role: "user", content: "Get the temperature in London" },
    { role: "assistant", content: "", toolCalls: [{ id: "original-call", type: "function", function: { name: "lookup_temperature", arguments: '{"city":"London"}' } }] },
    { role: "tool", toolCallId: "original-call", content: '{"temperature":21}' }
  ]
  const original = JSON.stringify(messages)
  await collect(apfelText("apple").chatStream({ ...request, messages }))
  const final = state.requests[1].body.messages
  assert.equal(final.length, 3)
  assert.equal(final[0].role, "user")
  assert.match(final[0].content, /^Get the temperature in London/)
  assert.match(final[0].content, /working notes/)
  assert.equal(final.at(-1)?.role, "tool")
  assert.equal(final.at(-1)?.content, '{"temperature":21}')
  assert.equal(JSON.stringify(messages), original)
})


test("Apfel preserves provider token accounting without clamping or claiming a natural stop exhausted its budget", async () => {
  reset(); state.draftTokens = 67; state.draftFinish = "stop"
  const result = await apfelText("apple").structuredOutput(options({ level: "high", budgetTokens: 64 }))
  assert.equal(state.requests[0].body.max_tokens, 64)
  assert.equal(result.usage.providerUsageDetails.thinkingTokens, 67)
  assert.equal(result.usage.providerUsageDetails.thinkingBudgetExhausted, false)
  assert.equal(result.usage.completionTokens, 70)
})


test("Apfel cancellation at the stream's RUN_STARTED prevents the draft request", async () => {
  reset()
  const events: Array<Record<string, unknown>> = []
  for await (const event of apfelText("apple").structuredOutputStream(options({ level: "high", budgetTokens: 4 }))) {
    events.push(event)
    if (event.type === "RUN_STARTED") state.controller.abort(new Error("cancel at run start"))
  }
  assert.deepEqual(events.map(e => e.type), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(events[1].code, "aborted"); assert.equal(events[1].message, "cancel at run start")
  assert.equal(state.requests.length, 0)
})
