import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import type { TextOptions } from "@tanstack/ai"

import type { WorkerReply, WorkerRequest } from "./protocol.js"

type Generate = Extract<WorkerRequest, { type: "generate" }>
type Chunk = { type: string; [key: string]: unknown }

/** A stand-in for the package's worker, scripted per test. */
class FakeWorker {
  static all: Array<FakeWorker> = []
  /** What a generate request gets back. */
  static reply: (worker: FakeWorker, request: Generate) => void = () => undefined
  onmessage: ((event: { data: WorkerReply }) => void) | null = null
  onerror: unknown = null
  posted: Array<WorkerRequest> = []
  terminated = false
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(request: WorkerRequest) {
    this.posted.push(request)
    if (request.type === "load") {
      setTimeout(() => {
        this.send({ status: "progress", progress: 0.5 })
        this.send({ status: "ready" })
      }, 0)
    } else if (request.type === "generate") {
      setTimeout(() => FakeWorker.reply(this, request), 0)
    }
  }
  send(data: WorkerReply) {
    this.onmessage?.({ data })
  }
  /** Sends text pieces, then completes with these counts. */
  stream(pieces: Array<string>, outputTokens = pieces.length) {
    for (const output of pieces) this.send({ status: "update", output })
    this.send({ status: "complete", inputTokens: 12, outputTokens })
  }
  terminate() {
    this.terminated = true
  }
}
Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker })

const { transformersJsText } = await import("./adapter.js")

const MODEL = "onnx-community/LFM3-1.7B-ONNX"
const noop = () => undefined
const logger = { request: noop, provider: noop, errors: noop, warn: noop } as unknown as TextOptions["logger"]
const lastWorker = () => FakeWorker.all.at(-1) as FakeWorker
const generateRequests = () =>
  FakeWorker.all.flatMap((w) => w.posted).filter((r): r is Generate => r.type === "generate")

function options(extra: Partial<TextOptions> = {}): TextOptions {
  return { logger, model: MODEL, threadId: "t", messages: [{ role: "user", content: "Hi" }], ...extra }
}

async function run(extra: Partial<TextOptions> = {}, model = MODEL) {
  const chunks: Array<Chunk> = []
  for await (const chunk of transformersJsText(model).chatStream(options(extra))) chunks.push(chunk as Chunk)
  return chunks
}

beforeEach(() => {
  FakeWorker.reply = (worker) => worker.stream(["Hello ", "there"])
})

test("text streams as one message, then RUN_FINISHED with usage", async () => {
  const chunks = await run()
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]
  )
  const finished = chunks.at(-1) as Chunk
  assert.equal(finished.finishReason, "stop")
  assert.deepEqual(finished.usage, { promptTokens: 12, completionTokens: 2, totalTokens: 14 })
  assert.equal(chunks[3].content, "Hello there")
})

test("the conversation and tools go to the chat template, with the model card's sampling", async () => {
  await run({
    systemPrompts: ["Be brief."],
    tools: [{ name: "get_weather", description: "Weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [
      { role: "user", content: "Weather in Oslo?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }]
      },
      { role: "tool", toolCallId: "c1", content: '{"temp":3}' },
      { role: "tool", toolCallId: "c1", content: "", error: "offline" }
    ]
  })
  const request = generateRequests().at(-1) as Generate
  assert.deepEqual(request.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather in Oslo?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Oslo" } } }]
    },
    { role: "tool", tool_call_id: "c1", name: "get_weather", content: '{"temp":3}' },
    { role: "tool", tool_call_id: "c1", name: "get_weather", content: '{"error":true,"message":"offline"}' }
  ])
  assert.deepEqual(request.tools, [
    {
      type: "function",
      function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }
    }
  ])
  // LFM3's card: its repo's generation_config.json doesn't carry it.
  assert.deepEqual(request.options, { max_new_tokens: 4096, do_sample: true, temperature: 0.1, top_k: 50, repetition_penalty: 1.1 })
  assert.equal(request.enableThinking, false)
})

test("a model whose repo carries its sampling gets none from the adapter", async () => {
  await run({ model: "onnx-community/Qwen3.5-2B-ONNX" }, "onnx-community/Qwen3.5-2B-ONNX")
  assert.deepEqual((generateRequests().at(-1) as Generate).options, { max_new_tokens: 4096 })
})

test("modelOptions and reasoning map to generate options and enable_thinking", async () => {
  await run({
    reasoning: { level: "high", summary: true },
    modelOptions: { maxCompletionTokens: 100, temperature: 0, topP: 0.9, topK: 20, repetitionPenalty: 1.1 }
  })
  const request = generateRequests().at(-1) as Generate
  assert.equal(request.enableThinking, true)
  assert.deepEqual(request.options, {
    max_new_tokens: 100,
    do_sample: false,
    top_p: 0.9,
    top_k: 20,
    repetition_penalty: 1.1
  })
  // Thinking without a cap gets the longer default.
  await run({ reasoning: { level: "high", summary: true } })
  assert.equal((generateRequests().at(-1) as Generate).options.max_new_tokens, 8192)
})

test("a tool call becomes TOOL_CALL events, stops the worker, and finishes with tool_calls", async () => {
  FakeWorker.reply = (worker) =>
    worker.stream(["Checking. ", "<|tool_call_start|>", '[get_weather(city="Oslo")]', "<|tool_call_end|>", " ignored"])
  const chunks = await run({ tools: [{ name: "get_weather", description: "Weather" }] })
  const types = chunks.map((c) => c.type)
  assert.deepEqual(types.slice(-5), ["TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
  const end = chunks.find((c) => c.type === "TOOL_CALL_END") as Chunk
  assert.equal(end.toolCallName, "get_weather")
  assert.deepEqual(end.input, { city: "Oslo" })
  assert.equal((chunks.at(-1) as Chunk).finishReason, "tool_calls")
  const text = chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").at(-1) as Chunk
  assert.equal(text.content, "Checking. ")
  assert.ok(lastWorker().posted.some((r) => r.type === "interrupt"))
})

test("thinking between <think> tags comes back as REASONING events, then the answer as text", async () => {
  FakeWorker.reply = (worker) => worker.stream(["<think>", "Let me ", "check.", "</think>", "\n\nHi!"])
  const chunks = await run()
  assert.deepEqual(chunks.map((c) => c.type), [
    "RUN_STARTED",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_END",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ])
  assert.equal(chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta).join(""), "Let me check.")
  assert.equal((chunks.find((c) => c.type === "TEXT_MESSAGE_CONTENT") as Chunk).content, "\n\nHi!")
})

test("text after a tool call in the same piece is dropped", async () => {
  FakeWorker.reply = (worker) => worker.stream(["<|tool_call_start|>[get_weather(city=\"Oslo\")]<|tool_call_end|>I am checking"])
  const chunks = await run({ tools: [{ name: "get_weather", description: "Weather" }] })
  assert.ok(!chunks.some((c) => c.type === "TEXT_MESSAGE_CONTENT"))
  assert.equal((chunks.find((c) => c.type === "TOOL_CALL_END") as Chunk).toolCallName, "get_weather")
})

test("toolChoice none sends no tools", async () => {
  await run({ tools: [{ name: "get_weather", description: "Weather" }], toolChoice: "none" })
  assert.equal((generateRequests().at(-1) as Generate).tools, undefined)
})

test("a reply that uses every token finishes with length", async () => {
  FakeWorker.reply = (worker) => worker.stream(["long"], 5)
  const chunks = await run({ modelOptions: { maxCompletionTokens: 5 } })
  assert.equal((chunks.at(-1) as Chunk).finishReason, "length")
})

test("an abort interrupts the worker and ends with RUN_ERROR", async () => {
  const controller = new AbortController()
  FakeWorker.reply = (worker) => {
    worker.send({ status: "update", output: "Hel" })
    controller.abort()
    setTimeout(() => worker.send({ status: "complete", inputTokens: 12, outputTokens: 1 }), 0)
  }
  const chunks = await run({ abortController: controller })
  const error = chunks.at(-1) as Chunk
  assert.equal(error.type, "RUN_ERROR")
  assert.equal(error.code, "aborted")
  assert.ok(lastWorker().posted.some((r) => r.type === "interrupt"))
})

test("a worker error ends with RUN_ERROR", async () => {
  FakeWorker.reply = (worker) => worker.send({ status: "error", message: "out of memory" })
  const chunks = await run()
  assert.deepEqual(chunks.map((c) => c.type), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(chunks[1].message, "out of memory")
})

test("structured output is refused", async () => {
  await assert.rejects(
    transformersJsText(MODEL).structuredOutput(),
    /not supported/
  )
})

test("availability, create and destroy", async () => {
  const other = "someone/Other-ONNX"
  const adapter = transformersJsText(other)
  // No WebGPU here: a listed model without CPU weights can't run, any other id may.
  assert.equal(await transformersJsText("LiquidAI/LFM2.5-350M-ONNX").availability(), "unavailable")
  assert.equal(await adapter.availability(), "downloadable")
  const progress: Array<number> = []
  const ready = adapter.create({ onDownloadProgress: (p) => progress.push(p) })
  assert.equal(await adapter.availability(), "downloading")
  assert.equal(await ready, adapter)
  assert.deepEqual(progress, [0.5, 1])
  assert.equal(await adapter.availability(), "available")
  const load = lastWorker().posted.at(-1)
  assert.deepEqual(load, { type: "load", settings: { model: other } })
  // Loaded already: no second load, and progress says 1.
  const again: Array<number> = []
  await adapter.create({ onDownloadProgress: (p) => again.push(p) })
  assert.deepEqual(again, [1])
  assert.equal(lastWorker().posted.filter((r) => r.type === "load" && r.settings.model === other).length, 1)
  await adapter.destroy()
  assert.ok(lastWorker().terminated)
  assert.equal(await adapter.availability(), "downloadable")
})

test("an aborted create rejects at once", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(transformersJsText("someone/Third-ONNX").create({ signal: controller.signal }), { name: "AbortError" })
})
