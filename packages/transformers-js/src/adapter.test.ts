import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import type { TextOptions } from "@tanstack/ai"
import type { TransformersJsTextProviderOptions } from "./adapter.js"
import type { RunTimings, WorkerRequest, WorkerResponse } from "./protocol.js"

class FakeWorker {
  static last: FakeWorker
  static ready = true
  static generate: (worker: FakeWorker, request: Extract<WorkerRequest, { type: "generate" }>) => void
  onmessage?: (event: { data: WorkerResponse }) => void
  posted: WorkerRequest[] = []
  constructor() { FakeWorker.last = this }
  postMessage(request: WorkerRequest) {
    this.posted.push(request)
    if (request.type === "load" && FakeWorker.ready) setTimeout(() => this.send({ type: "ready", modelId: request.modelId }), 0)
    if (request.type === "generate") FakeWorker.generate(this, request)
  }
  send(data: WorkerResponse) { this.onmessage?.({ data }) }
  terminate() { this.onmessage = undefined }
}
Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker })
const MODEL = "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"
const stats: RunTimings = { inputTokens: 10, cachedTokens: 0, outputTokens: 20, firstTokenMs: 1, promptMs: 1, decodeMs: 1, thinkingTokens: 4, thinkingBudgetTokens: 512, thinkingBudgetExhausted: false }
function options(): TextOptions<TransformersJsTextProviderOptions> {
  return { logger: resolveDebugOption(false), model: MODEL, threadId: "tjs-adapter-test", messages: [{ role: "user", content: "choose a move" }], reasoning: { level: "high", summary: true, budgetTokens: 512 }, modelOptions: { maxTokens: 8192 } }
}
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"], additionalProperties: false }

test("structured output forwards the schema, canonical token cap, thinking cap, and model context default", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    assert.deepEqual(request.outputSchema, schema)
    assert.equal(request.maxTokens, 8192)
    assert.equal(request.contextLength, undefined)
    assert.equal(request.thinking, true)
    assert.equal(request.thinkingBudgetTokens, 512)
    assert.equal(request.thinkingClose, "</think>")
    worker.send({ type: "token", id: request.id, text: '<think>plan</think>{"moveId":"b6-a5"}' })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const result = await transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), modelOptions: { maxTokens: 8192, max_new_tokens: 64 } }, outputSchema: schema })
    assert.deepEqual(result.data, { moveId: "b6-a5" })
    assert.equal(result.usage?.providerUsageDetails?.thinkingTokens, 4)
  } finally { unloadModel() }
})

test("required and specific tools use constrained decisions and arguments, emitting one tool call", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const tools = [{ name: "lookup", description: "Look up a query", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }]
  for (const toolChoice of ["required", { type: "tool", name: "lookup" }] as const) {
    unloadModel()
    let requests = 0
    FakeWorker.generate = (worker, request) => {
      requests++
      const requested = request.outputSchema as { properties: Record<string, unknown> }
      const json = requested.properties.action ? { action: "lookup" } : { query: "checkers" }
      worker.send({ type: "token", id: request.id, text: JSON.stringify(json) })
      worker.send({ type: "done", id: request.id, stats })
    }
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools, toolChoice })) chunks.push(chunk)
    assert.equal(requests, toolChoice === "required" ? 2 : 1)
    const end = chunks.find(chunk => chunk.type === "TOOL_CALL_END")
    assert.ok(end && end.type === "TOOL_CALL_END")
    assert.equal(end.toolCallName, "lookup")
    assert.deepEqual(end.input, { query: "checkers" })
    assert.equal(chunks.filter(chunk => chunk.type === "RUN_STARTED").length, 1)
    unloadModel()
  }
})

test("native auto can answer without a JSON routing decision", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  let requests = 0
  FakeWorker.generate = (worker, request) => {
    requests++
    worker.send({ type: "token", id: request.id, text: request.outputSchema ? '{"action":"answer"}' : "Hello" })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.equal(requests, 1)
    assert.equal(chunks.filter(chunk => chunk.type === "RUN_STARTED").length, 1)
    assert.ok(chunks.some(chunk => chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta === "Hello"))
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START"))
  } finally { unloadModel() }
})

test("invalid token budgets fail before loading a worker", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  const previous = FakeWorker.last
  for (const maxTokens of [-1, 0.5, NaN, Infinity]) {
    await assert.rejects(transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), modelOptions: { maxTokens } }, outputSchema: schema }), /nonnegative safe integer/)
    assert.equal(FakeWorker.last, previous)
  }
})


test("canceling model loading rejects promptly without generating", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.ready = false
  try {
    const controller = new AbortController()
    const request = transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), abortController: controller }, outputSchema: schema })
    controller.abort(new Error("cancel pending model"))
    await assert.rejects(request, /cancel pending model/)
    assert.ok(!FakeWorker.last.posted.some(request => request.type === "generate"))
  } finally { FakeWorker.ready = true; unloadModel() }
})


test("request-only signal cancels structured model loading", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel(); FakeWorker.ready = false
  try {
    const controller = new AbortController()
    const request = transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), request: new Request("http://localhost", { signal: controller.signal }) }, outputSchema: schema })
    controller.abort(new Error("request canceled"))
    await assert.rejects(request, /request canceled/)
    assert.ok(!FakeWorker.last.posted.some(request => request.type === "generate"))
  } finally { FakeWorker.ready = true; unloadModel() }
})


test("toolChoice none never emits tool events for spontaneous native markup", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  const { formatLfm2ToolCalls, parseToolCalls } = await import("./tool-calls.js")
  const markup = formatLfm2ToolCalls([{ name: "lookup", args: { query: "checkers" } }])
  assert.equal(parseToolCalls(markup).length, 1, "the fixture is a recognized native tool call")
  FakeWorker.generate = (worker, request) => {
    assert.deepEqual(request.tools, [])
    worker.send({ type: "token", id: request.id, text: markup })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), toolChoice: "none", tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START" || chunk.type === "TOOL_CALL_END"))
    const text = chunks.filter(chunk => chunk.type === "TEXT_MESSAGE_CONTENT").map(chunk => chunk.delta).join("")
    assert.equal(text, markup)
  } finally { unloadModel() }
})


test("no declared tools means model tool markup remains ordinary text", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls, parseToolCalls } = await import("./tool-calls.js")
  const markup = formatLfm2ToolCalls([{ name: "unavailable", args: {} }])
  assert.equal(parseToolCalls(markup).length, 1)
  for (const tools of [undefined, []]) {
    unloadModel()
    FakeWorker.generate = (worker, request) => {
      assert.deepEqual(request.tools, [])
      worker.send({ type: "token", id: request.id, text: markup })
      worker.send({ type: "done", id: request.id, stats })
    }
    try {
      const chunks = []
      for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools })) chunks.push(chunk)
      assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START" || chunk.type === "TOOL_CALL_END"))
      assert.equal(chunks.filter(chunk => chunk.type === "TEXT_MESSAGE_CONTENT").map(chunk => chunk.delta).join(""), markup)
      const final = chunks.find(chunk => chunk.type === "RUN_FINISHED")
      assert.ok(final && final.type === "RUN_FINISHED")
      assert.equal(final.finishReason, "stop")
    } finally { unloadModel() }
  }
})


test("native auto preserves tool choice and repairs invalid arguments under the selected schema", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  unloadModel(); let requests = 0
  const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }
  FakeWorker.generate = (worker, request) => {
    requests++
    if (requests === 1) {
      assert.equal(request.outputSchema, undefined)
      assert.equal(request.tools[0].function.name, "lookup")
      worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "lookup", args: { query: 9 } }]) })
    } else {
      assert.deepEqual(request.outputSchema, inputSchema)
      worker.send({ type: "token", id: request.id, text: '{"query":"checkers"}' })
    }
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema }] })) chunks.push(chunk)
    assert.equal(requests, 2)
    const end = chunks.find(chunk => chunk.type === "TOOL_CALL_END")
    assert.ok(end && end.type === "TOOL_CALL_END")
    assert.equal(end.toolCallName, "lookup")
    assert.deepEqual(end.input, { query: "checkers" })
  } finally { unloadModel() }
})

test("native auto rejects undeclared tool calls before emitting tool events", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "unavailable", args: {} }]) })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === "RUN_ERROR" && chunk.message.includes("undeclared tool")))
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START"))
  } finally { unloadModel() }
})

test("valid native auto arguments emit directly without an extra model call", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  unloadModel(); let requests = 0
  FakeWorker.generate = (worker, request) => {
    requests++
    assert.equal(request.outputSchema, undefined)
    worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "lookup", args: { query: "checkers" } }]) })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] })) chunks.push(chunk)
    assert.equal(requests, 1)
    assert.ok(chunks.some(chunk => chunk.type === "TOOL_CALL_END" && chunk.toolCallName === "lookup"))
  } finally { unloadModel() }
})

test("malformed native auto envelopes fail before any tool event", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    worker.send({ type: "token", id: request.id, text: '<tool_call>{"name":</tool_call>' })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === "RUN_ERROR" && chunk.message.includes("malformed")))
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START"))
  } finally { unloadModel() }
})
