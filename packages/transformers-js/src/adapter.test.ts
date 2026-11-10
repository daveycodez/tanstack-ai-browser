import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
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
  /** The model the worker holds. */
  held: string | undefined
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(request: WorkerRequest) {
    this.posted.push(request)
    if (request.type === "load") {
      this.held = undefined
      setTimeout(() => {
        this.held = request.settings.model
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

test("a model the catalog doesn't list gets no sampling from the adapter: its repo's generation_config.json applies", async () => {
  await run({ model: "someone/Some-Model-ONNX" }, "someone/Some-Model-ONNX")
  assert.deepEqual((generateRequests().at(-1) as Generate).options, { max_new_tokens: 4096 })
})

test("Qwen3.5's card sampling: its non-thinking settings by default, its thinking settings while thinking", async () => {
  const qwen = "onnx-community/Qwen3.5-2B-ONNX"
  await run({ model: qwen }, qwen)
  assert.deepEqual((generateRequests().at(-1) as Generate).options, {
    max_new_tokens: 4096,
    do_sample: true,
    temperature: 1,
    top_p: 1,
    top_k: 20,
    repetition_penalty: 1
  })
  await run({ model: qwen, reasoning: { level: "high", summary: false } }, qwen)
  assert.equal((generateRequests().at(-1) as Generate).options.top_p, 0.95)
})

test("modelOptions go to generate() as given, over the card's sampling; reasoning maps to enable_thinking", async () => {
  await run({
    reasoning: { level: "high", summary: true },
    modelOptions: { max_new_tokens: 100, do_sample: false, top_p: 0.9, top_k: 20, no_repeat_ngram_size: 3 }
  })
  const request = generateRequests().at(-1) as Generate
  assert.equal(request.enableThinking, true)
  assert.deepEqual(request.options, {
    max_new_tokens: 100,
    do_sample: false,
    temperature: 0.1,
    top_p: 0.9,
    top_k: 20,
    repetition_penalty: 1.1,
    no_repeat_ngram_size: 3
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

/** Runs `chat()` with a get_weather tool that counts its runs, the model's first reply calling it. */
async function weatherRuns(extra: { toolChoice?: unknown; tools?: Array<{ name: string; description: string }> } = {}) {
  let runs = 0
  let generations = 0
  FakeWorker.reply = (worker) =>
    worker.stream(generations++ === 0 ? ["<|tool_call_start|>", '[get_weather(city="Oslo")]', "<|tool_call_end|>"] : ["Done."])
  const getWeather = {
    name: "get_weather",
    description: "Weather",
    execute: async () => {
      runs++
      return { temp: 3 }
    }
  }
  const stream = chat({
    adapter: transformersJsText(MODEL),
    threadId: "t",
    messages: [{ role: "user", content: "Weather in Oslo?" }],
    tools: [getWeather, ...(extra.tools ?? [])],
    ...(extra.toolChoice !== undefined && { toolChoice: extra.toolChoice as never })
  })
  const chunks: Array<Chunk> = []
  for await (const chunk of stream) chunks.push(chunk as Chunk)
  return { runs, chunks }
}

test("chat() runs a tool the model calls", async () => {
  assert.equal((await weatherRuns()).runs, 1)
})

test("toolChoice none: a call the model writes anyway is text, and no tool runs", async () => {
  const { runs, chunks } = await weatherRuns({ toolChoice: "none" })
  assert.equal(runs, 0)
  assert.ok(!chunks.some((c) => c.type === "TOOL_CALL_START"))
  const text = chunks
    .filter((c) => c.type === "TEXT_MESSAGE_CONTENT")
    .map((c) => c.delta)
    .join("")
  assert.equal(text, '<|tool_call_start|>[get_weather(city="Oslo")]<|tool_call_end|>')
})

test("toolChoice naming a tool: only that tool goes to the model, and a call to another doesn't run", async () => {
  const { runs } = await weatherRuns({
    toolChoice: { type: "tool", name: "lookup" },
    tools: [{ name: "lookup", description: "Look it up" }]
  })
  assert.equal(runs, 0)
  assert.deepEqual(
    generateRequests()
      .at(-1)
      ?.tools?.map((t) => t.function.name),
    ["lookup"]
  )
})

test("two overlapping requests for different models each generate on their own model", async () => {
  FakeWorker.reply = (worker) => worker.stream([`on ${worker.held}`])
  const a = "someone/Model-A-ONNX"
  const b = "someone/Model-B-ONNX"
  const [chunksA, chunksB] = await Promise.all([run({ model: a }, a), run({ model: b }, b)])
  const text = (chunks: Array<Chunk>) => (chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").at(-1) as Chunk).content
  assert.equal(text(chunksA), `on ${a}`)
  assert.equal(text(chunksB), `on ${b}`)
})

test("a request aborted while it waits for the worker never starts its generation", async () => {
  let finish: (() => void) | undefined
  FakeWorker.reply = (worker) => {
    // The first generation waits for `finish`; any later one completes at once.
    if (finish) return worker.stream(["Second"])
    worker.send({ status: "update", output: "First" })
    finish = () => worker.send({ status: "complete", inputTokens: 1, outputTokens: 1 })
  }
  const first = run()
  // Wait until the first request is generating.
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
  const before = generateRequests().length
  const controller = new AbortController()
  const second = run({ abortController: controller })
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort()
  finish?.()
  await first
  const chunks = await second
  assert.equal((chunks.at(-1) as Chunk).code, "aborted")
  assert.equal(generateRequests().length, before)
})

test("a reply that uses every token finishes with length", async () => {
  FakeWorker.reply = (worker) => worker.stream(["long"], 5)
  const chunks = await run({ modelOptions: { max_new_tokens: 5 } })
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

test("images: the vision encoder loads with the first image, each image in its place, and stays loaded for text", async () => {
  const qwen = "onnx-community/Qwen3.5-0.8B-ONNX"
  assert.deepEqual(transformersJsText(qwen).inputModalities, ["text", "image"])
  assert.deepEqual(transformersJsText(MODEL).inputModalities, ["text"])
  assert.equal(transformersJsText("someone/Unlisted-ONNX").inputModalities, undefined)
  const image = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } } as const
  await run({ model: qwen, messages: [{ role: "user", content: [image, { type: "text", content: "What's this?" }] }] }, qwen)
  const loads = () => FakeWorker.all.flatMap((w) => w.posted).filter((r) => r.type === "load" && r.settings.model === qwen)
  assert.deepEqual(loads().at(-1), { type: "load", settings: { model: qwen, vision: true } })
  const request = generateRequests().at(-1) as Generate
  assert.deepEqual(request.messages.at(-1), { role: "user", content: [{ type: "image" }, { type: "text", text: "What's this?" }] })
  assert.deepEqual(request.images, ["data:image/png;base64,AAAA"])
  // Text afterwards: no reload without the encoder.
  await run({ model: qwen }, qwen)
  assert.equal(loads().length, 1)
  assert.equal((generateRequests().at(-1) as Generate).images, undefined)
})
