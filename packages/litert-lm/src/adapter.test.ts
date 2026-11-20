import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"
import type { ConversationConfig, EngineSettings, Message, MessageLike } from "@litert-lm/core"

import { litertLmText, modelInput } from "./adapter.js"
import type { LiteRtLmRuntime, RuntimeConversation, RuntimeEngine } from "./runtime.js"

type Chunk = { type: string; [key: string]: unknown }

const noop = () => undefined
const logger = { request: noop, provider: noop, errors: noop, warn: noop } as unknown as TextOptions["logger"]

const GEMMA = "litert-community/gemma-4-E2B-it-litert-lm"
const RAON = "KRAFTON/Raon-1-nano-litert-lm"

/** A conversation that answers its turn with scripted chunks. */
class FakeConversation implements RuntimeConversation {
  sent: Array<MessageLike> = []
  cancelled = 0
  deleted = 0
  constructor(
    readonly config: ConversationConfig | undefined,
    private readonly chunks: Array<Message>,
    private readonly counts: { read: number; written: number },
    /** Chunks wait for this, when set (a reply that never ends until it's stopped). */
    private readonly hold?: Promise<void>
  ) {}
  sendMessageStreaming(message: MessageLike) {
    this.sent.push(message)
    const { chunks, hold } = this
    return new ReadableStream<Message>({
      async start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        await hold
        controller.close()
      }
    })
  }
  cancel() {
    this.cancelled++
  }
  async getBenchmarkInfo() {
    return { lastPrefillTokenCount: this.counts.read, lastDecodeTokenCount: this.counts.written }
  }
  async delete() {
    this.deleted++
  }
}

/** A runtime whose engines answer each conversation with the next scripted reply. */
class FakeRuntime implements LiteRtLmRuntime {
  resolved: Array<string> = []
  created: Array<EngineSettings> = []
  engines: Array<{ settings: EngineSettings; deleted: number }> = []
  conversations: Array<FakeConversation> = []
  /** Chunks for each conversation, in turn. */
  replies: Array<Array<Message>> = []
  counts = { read: 20, written: 5 }
  hold: Promise<void> | undefined
  loaded: Array<string> = []
  failure: Error | undefined

  Engine = {
    create: async (settings: EngineSettings): Promise<RuntimeEngine> => {
      if (this.failure) throw this.failure
      this.created.push(settings)
      const record = { settings, deleted: 0 }
      this.engines.push(record)
      return {
        settings: { mainExecutorSettings: { maxNumTokens: settings.mainExecutorSettings?.maxNumTokens ?? 4096 } },
        createConversation: async (config) => {
          const conversation = new FakeConversation(config, this.replies.shift() ?? [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], this.counts, this.hold)
          this.conversations.push(conversation)
          return conversation
        },
        delete: async () => {
          record.deleted++
        }
      }
    }
  }
  async resolveModel(model: string) {
    this.resolved.push(model)
    return { model: model.startsWith("hf://") ? { url: `https://huggingface.co/${model.slice(5)}/resolve/abc123/model.litertlm`, size: 100 } : model }
  }
  async loadLiteRtLm(path: string) {
    this.loaded.push(path)
  }
}

let runtime: FakeRuntime
beforeEach(() => {
  runtime = new FakeRuntime()
})

const text = (...pieces: Array<string>): Array<Message> => pieces.map((piece) => ({ role: "assistant", content: [{ type: "text", text: piece }] }))
const user = (content: string) => ({ role: "user", content })
const weather = {
  name: "get_weather",
  description: "Weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
}

async function stream(model: string, options: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const adapter = litertLmText(model, { runtime, ...config })
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.chatStream({ threadId: "t", logger, ...options } as never)) chunks.push(chunk as Chunk)
  return { adapter, chunks, types: chunks.map((c) => c.type) }
}

test("a reply streams as text events, with the engine's token counts", async () => {
  runtime.replies = [text("The capital ", "is Paris.")]
  const { chunks, types } = await stream(GEMMA, { messages: [user("Capital of France?")] })
  assert.deepEqual(types, ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"])
  assert.equal(chunks[3].content, "The capital is Paris.")
  const finished = chunks.at(-1) as Chunk
  assert.equal(finished.finishReason, "stop")
  assert.deepEqual(finished.usage, { promptTokens: 20, completionTokens: 5, totalTokens: 25 })
  assert.equal(runtime.conversations[0].deleted, 1)
})

test("a repository name loads as its hf:// URI, with LiteRT-LM's settings as given", async () => {
  await stream(GEMMA, { messages: [user("hi")] }, { engineSettings: { mainExecutorSettings: { maxNumTokens: 2048 } }, wasmPath: "/wasm/" })
  assert.deepEqual(runtime.resolved, [`hf://${GEMMA}`])
  assert.deepEqual(runtime.loaded, ["/wasm/"])
  // No Cache Storage here (Node): the runtime gets the file's URL and streams it itself.
  assert.deepEqual(runtime.created, [
    { benchmarkEnabled: true, mainExecutorSettings: { maxNumTokens: 2048 }, model: `https://huggingface.co/${GEMMA}/resolve/abc123/model.litertlm` }
  ])
})

test("a URL and a hf:// URI go to LiteRT-LM as given", () => {
  assert.equal(modelInput("owner/name"), "hf://owner/name")
  assert.equal(modelInput("hf://owner/name@main/file.litertlm"), "hf://owner/name@main/file.litertlm")
  assert.equal(modelInput("https://example.com/model.litertlm"), "https://example.com/model.litertlm")
  assert.equal(modelInput("models/gemma.litertlm"), "models/gemma.litertlm")
})

test("an access token goes with the model's URL where the runtime downloads it", async () => {
  await stream(GEMMA, { messages: [user("hi")] }, { accessToken: "hf_user" })
  assert.deepEqual(runtime.created[0].model, { url: `https://huggingface.co/${GEMMA}/resolve/abc123/model.litertlm`, accessToken: "hf_user" })
})

test("a step is one conversation: the system prompt, the history and the tools as its preface, the last message as its turn", async () => {
  await stream(GEMMA, {
    systemPrompts: ["Be brief."],
    tools: [weather],
    messages: [
      user("Weather in Paris?"),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", toolCallId: "c1", content: '{"temperature_c":11}' }
    ]
  })
  const [conversation] = runtime.conversations
  assert.deepEqual(conversation.config?.preface, {
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Paris?" },
      { role: "assistant", content: "", tool_calls: [{ type: "function", id: "c1", function: { name: "get_weather", arguments: { city: "Paris" } } }] }
    ],
    tools: [{ type: "function", function: { name: "get_weather", description: "Weather for a city", parameters: weather.inputSchema } }]
  })
  assert.deepEqual(conversation.sent, [{ role: "tool", content: [{ type: "tool_response", name: "get_weather", response: { temperature_c: 11 } }] }])
})

test("reasoning switches the template's thinking, and enableThinking goes over it", async () => {
  await stream(GEMMA, { messages: [user("hi")], reasoning: { level: "high" } })
  await stream(GEMMA, { messages: [user("hi")], reasoning: { level: "off" } })
  await stream(GEMMA, { messages: [user("hi")], reasoning: { level: "off" }, modelOptions: { enableThinking: true } })
  await stream(GEMMA, { messages: [user("hi")] })
  assert.deepEqual(
    runtime.conversations.map((c) => c.config?.preface?.extra_context),
    [{ enable_thinking: true }, { enable_thinking: false }, { enable_thinking: true }, undefined]
  )
})

test("a listed model that doesn't think isn't asked to; one the catalog doesn't list gets the switch", async () => {
  await stream(RAON, { messages: [user("hi")], reasoning: { level: "high" } })
  await stream("someone/other-litert-lm", { messages: [user("hi")], reasoning: { level: "high" } })
  assert.deepEqual(
    runtime.conversations.map((c) => c.config?.preface?.extra_context),
    [undefined, { enable_thinking: true }]
  )
})

test("thinking streams as reasoning, closed before the answer", async () => {
  runtime.replies = [
    [
      { role: "assistant", channels: { thought: "Let me " } },
      { role: "assistant", channels: { thought: "think." } },
      { role: "assistant", content: [{ type: "text", text: "Yes." }] }
    ]
  ]
  const { chunks, types } = await stream(GEMMA, { messages: [user("Is 7 prime?")], reasoning: { level: "high" } })
  assert.deepEqual(types, [
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
  assert.deepEqual(
    chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta),
    ["Let me ", "think."]
  )
})

test("the runtime's tool calls come out as calls", async () => {
  runtime.replies = [
    [
      {
        role: "assistant",
        tool_calls: [
          { type: "function", id: "call_7", function: { name: "get_weather", arguments: { city: "Paris" } } },
          { type: "function", function: { name: "get_weather", arguments: { city: "Rome" } } }
        ]
      }
    ]
  ]
  const { chunks, types } = await stream(GEMMA, { messages: [user("Weather in Paris and Rome?")], tools: [weather] })
  assert.deepEqual(types, ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
  const ends = chunks.filter((c) => c.type === "TOOL_CALL_END")
  assert.equal(ends[0].toolCallId, "call_7")
  assert.deepEqual(ends[0].input, { city: "Paris" })
  assert.equal(ends[0].args, '{"city":"Paris"}')
  // A call the runtime gave no id gets one.
  assert.match(String(ends[1].toolCallId), /^call_/)
  assert.deepEqual(ends[1].input, { city: "Rome" })
  assert.equal((chunks.at(-1) as Chunk).finishReason, "tool_calls")
})

test("toolChoice none offers no tools, and a named one only that tool", async () => {
  const other = { ...weather, name: "get_time" }
  await stream(GEMMA, { messages: [user("hi")], tools: [weather, other], toolChoice: "none" })
  await stream(GEMMA, { messages: [user("hi")], tools: [weather, other], toolChoice: { type: "function", name: "get_time" } })
  const offered = runtime.conversations.map((c) => (c.config?.preface?.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name))
  assert.deepEqual(offered, [[], ["get_time"]])
})

test("modelOptions are LiteRT-LM's own session and conversation settings", async () => {
  await stream(GEMMA, {
    messages: [user("hi")],
    modelOptions: { samplerParams: { temperature: 0.7, k: 40, p: 0.9, seed: 1 }, maxOutputTokens: 64, enableConstrainedDecoding: true }
  })
  await stream(GEMMA, { messages: [user("hi")] })
  const [set, unset] = runtime.conversations.map((c) => c.config)
  assert.deepEqual(set?.sessionConfig, { samplerParams: { temperature: 0.7, k: 40, p: 0.9, seed: 1 }, maxOutputTokens: 64 })
  assert.equal(set?.enableConstrainedDecoding, true)
  assert.equal(unset?.sessionConfig, undefined)
  assert.equal("enableConstrainedDecoding" in (unset ?? {}), false)
})

test("a reply that used its whole token cap finishes with length", async () => {
  runtime.counts = { read: 10, written: 16 }
  const { chunks } = await stream(GEMMA, { messages: [user("A long story")], modelOptions: { maxOutputTokens: 16 } })
  assert.equal((chunks.at(-1) as Chunk).finishReason, "length")
})

test("without the engine's benchmark there's no usage", async () => {
  runtime.counts = { read: 0, written: 0 }
  const { chunks } = await stream(GEMMA, { messages: [user("hi")] })
  assert.equal("usage" in (chunks.at(-1) as Chunk), false)
})

test("stopping a reply cancels the generation and ends the run as aborted", async () => {
  let release: () => void = noop
  runtime.hold = new Promise<void>((resolve) => (release = resolve))
  runtime.replies = [text("Once upon")]
  const controller = new AbortController()
  const adapter = litertLmText(GEMMA, { runtime })
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.chatStream({ threadId: "t", logger, messages: [user("A story")], abortController: controller } as never)) {
    chunks.push(chunk as Chunk)
    if (chunk.type === "TEXT_MESSAGE_CONTENT") controller.abort()
  }
  release()
  const [conversation] = runtime.conversations
  assert.equal(conversation.cancelled, 1)
  assert.equal(conversation.deleted, 1)
  const last = chunks.at(-1) as Chunk
  assert.equal(last.type, "RUN_ERROR")
  assert.equal(last.code, "aborted")
})

test("a request stopped before it starts makes no conversation", async () => {
  const controller = new AbortController()
  controller.abort()
  const { chunks } = await stream(GEMMA, { messages: [user("hi")], abortController: controller })
  assert.equal((chunks.at(-1) as Chunk).code, "aborted")
  assert.equal(runtime.conversations.length, 0)
})

test("a model that fails to load ends the run with the runtime's error, and loads again next time", async () => {
  runtime.failure = new Error("WebGPU device lost")
  const failed = await stream(GEMMA, { messages: [user("hi")] })
  assert.equal((failed.chunks.at(-1) as Chunk).type, "RUN_ERROR")
  assert.equal((failed.chunks.at(-1) as Chunk).message, "WebGPU device lost")
  runtime.failure = undefined
  const { types } = await stream(GEMMA, { messages: [user("hi")] })
  assert.equal(types.at(-1), "RUN_FINISHED")
})

test("anything but text in a message ends the run as unsupported input", async () => {
  const { chunks } = await stream(GEMMA, {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "url", value: "https://example.com/a.png" } }] }]
  })
  assert.equal((chunks.at(-1) as Chunk).code, "unsupported-input")
  assert.equal(runtime.conversations.length, 0)
})

test("the page keeps one engine: another model deletes the one before it, the same model shares it", async () => {
  const first = await stream(GEMMA, { messages: [user("hi")] })
  await stream(GEMMA, { messages: [user("again")] })
  assert.equal(runtime.engines.length, 1)
  await stream(RAON, { messages: [user("hi")] })
  assert.equal(runtime.engines.length, 2)
  assert.equal(runtime.engines[0].deleted, 1)
  assert.equal(runtime.engines[1].deleted, 0)
  // The first adapter's engine is gone: destroying it leaves the page's engine alone.
  await first.adapter.destroy()
  assert.equal(runtime.engines[1].deleted, 0)
})

test("create loads the model and reports 1; destroy deletes its engine", async () => {
  const heard: Array<number> = []
  const calls: Array<number> = []
  const adapter = litertLmText(GEMMA, { runtime, onDownloadProgress: (value) => heard.push(value) })
  assert.equal(await adapter.contextSize(), undefined)
  assert.equal(await adapter.create({ onDownloadProgress: (value) => calls.push(value) }), adapter)
  assert.deepEqual(heard, [1])
  assert.deepEqual(calls, [1])
  assert.equal(await adapter.contextSize(), 4096)
  await adapter.destroy()
  assert.equal(runtime.engines[0].deleted, 1)
  assert.equal(await adapter.contextSize(), undefined)
})

test("availability is unavailable without WebGPU, and available once the engine is loaded", async () => {
  const adapter = litertLmText(GEMMA, { runtime })
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  try {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true })
    assert.equal(await adapter.availability(), "unavailable")
    Object.defineProperty(globalThis, "navigator", { value: { gpu: {} }, configurable: true })
    assert.equal(await adapter.availability(), "downloadable")
    await adapter.create()
    assert.equal(await adapter.availability(), "available")
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
})

test("a structured answer has its schema in the system instruction, thinking off, and is read as JSON", async () => {
  runtime.replies = [text('```json\n{"city":"Paris"}\n', "```")]
  const adapter = litertLmText(GEMMA, { runtime })
  const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  const result = await adapter.structuredOutput({
    outputSchema: schema,
    chatOptions: { threadId: "t", logger, systemPrompts: ["Be brief."], tools: [weather], messages: [user("Capital of France?")] }
  } as never)
  assert.deepEqual(result.data, { city: "Paris" })
  assert.equal(result.rawText, '{"city":"Paris"}')
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 5, totalTokens: 25 })
  const preface = runtime.conversations[0].config?.preface
  assert.equal(preface?.tools, undefined)
  assert.deepEqual(preface?.extra_context, { enable_thinking: false })
  const system = String(preface?.messages?.[0].content)
  assert.ok(system.startsWith("Be brief.\n\nAnswer with one JSON value"))
  assert.ok(system.endsWith(JSON.stringify(schema)))
})

test("a structured answer cut off at its token cap fails with the code length", async () => {
  runtime.counts = { read: 10, written: 8 }
  runtime.replies = [text('{"city":"Pa')]
  const adapter = litertLmText(GEMMA, { runtime })
  await assert.rejects(
    adapter.structuredOutput({
      outputSchema: { type: "object" },
      chatOptions: { threadId: "t", logger, messages: [user("Capital?")], modelOptions: { maxOutputTokens: 8 } }
    } as never),
    (error: { code?: string }) => error.code === "length"
  )
})

test("chat() runs a tool and sends its result back as the next step's turn", async () => {
  runtime.replies = [
    [{ role: "assistant", tool_calls: [{ type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }] }],
    text("It is 11°C in Paris.")
  ]
  let said = ""
  for await (const chunk of chat({
    adapter: litertLmText(GEMMA, { runtime }),
    threadId: "t",
    messages: [user("Weather in Paris?")],
    tools: [{ ...weather, execute: async () => ({ temperature_c: 11 }) }]
  } as never) as AsyncIterable<Chunk>) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT") said += chunk.delta as string
  }
  assert.equal(said, "It is 11°C in Paris.")
  assert.equal(runtime.conversations.length, 2)
  assert.deepEqual(runtime.conversations[1].sent, [{ role: "tool", content: [{ type: "tool_response", name: "get_weather", response: { temperature_c: 11 } }] }])
  assert.equal(runtime.engines.length, 1)
})
