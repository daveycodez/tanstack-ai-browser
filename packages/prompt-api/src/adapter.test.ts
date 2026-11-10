import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"

import { promptApiText } from "./adapter.js"
import type { PromptApiConfig } from "./adapter.js"

type Chunk = { type: string; [key: string]: unknown }
type Prompt = { kind: "prompt" | "stream"; input: unknown; options: Record<string, unknown> }

const noop = () => undefined
const logger = { request: noop, provider: noop, errors: noop, warn: noop } as unknown as TextOptions["logger"]

/** What the fake browser does, per test. */
const control = {
  creates: [] as Array<Record<string, unknown>>,
  prompts: [] as Array<Prompt>,
  /** The streamed reply, in these pieces. */
  pieces: ["Hello ", "there"] as Array<string>,
  /** prompt()'s reply. */
  answer: '{"city":"Tokyo"}',
  /** Thrown by create(), or by the prompt. */
  createFailure: undefined as unknown,
  promptFailure: undefined as unknown,
  /** Called before each streamed piece. */
  beforePiece: noop as (index: number) => void,
  /** Pieces written before the stream stopped. */
  written: 0,
  destroyed: 0,
  /** Download progress the browser reports on create. */
  progress: [0, 1] as Array<number>,
  /** Sessions made, in order. */
  sessions: [] as Array<EventTarget>
}

class FakeSession extends EventTarget {
  constructor() {
    super()
    control.sessions.push(this)
  }
  contextUsage = 120
  readonly contextWindow = 9216
  destroy() {
    control.destroyed++
  }
  async measureContextUsage(input: unknown) {
    return JSON.stringify(input).length
  }
  async prompt(input: unknown, options: Record<string, unknown> = {}) {
    control.prompts.push({ kind: "prompt", input, options })
    ;(options.signal as AbortSignal | undefined)?.throwIfAborted()
    if (control.promptFailure) throw control.promptFailure
    return control.answer
  }
  promptStreaming(input: unknown, options: Record<string, unknown> = {}) {
    control.prompts.push({ kind: "stream", input, options })
    const signal = options.signal as AbortSignal | undefined
    let index = 0
    return new ReadableStream<string>({
      pull(controller) {
        if (control.promptFailure) return controller.error(control.promptFailure)
        control.beforePiece(index)
        if (signal?.aborted) return controller.error(signal.reason)
        if (index >= control.pieces.length) return controller.close()
        control.written++
        controller.enqueue(control.pieces[index++])
      }
    })
  }
}

;(globalThis as { LanguageModel?: unknown }).LanguageModel = {
  availability: async () => "available",
  async create(options: Record<string, unknown>) {
    control.creates.push(options)
    if (control.createFailure) throw control.createFailure
    const monitor = new EventTarget()
    ;(options.monitor as ((m: EventTarget) => void) | undefined)?.(monitor)
    for (const loaded of control.progress) monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }))
    return new FakeSession()
  }
}

beforeEach(() => {
  Object.assign(control, {
    creates: [],
    prompts: [],
    pieces: ["Hello ", "there"],
    answer: '{"city":"Tokyo"}',
    createFailure: undefined,
    promptFailure: undefined,
    beforePiece: noop,
    written: 0,
    destroyed: 0,
    progress: [0, 1],
    sessions: []
  })
})

const chatOptions = (extra: Record<string, unknown> = {}) =>
  ({
    model: "built-in",
    logger,
    threadId: "thread",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    ...extra
  }) as unknown as TextOptions

async function run(extra: Record<string, unknown> = {}, config: PromptApiConfig = {}) {
  const chunks: Array<Chunk> = []
  for await (const chunk of promptApiText("built-in", config).chatStream(chatOptions(extra))) chunks.push(chunk as Chunk)
  return chunks
}
const typesOf = (chunks: Array<Chunk>) => chunks.map((c) => c.type)
const textIn = (chunks: Array<Chunk>) =>
  chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").map((c) => c.delta).join("")
const weather = { name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } }

test("a reply streams as text, on a session the thread keeps", async () => {
  const chunks = await run({ systemPrompts: ["Be brief."], modelOptions: { topK: 3 } })
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ])
  assert.equal(textIn(chunks), "Hello there")
  const finished = chunks.at(-1)
  assert.equal(finished?.finishReason, "stop")
  const usage = finished?.usage as { promptTokens: number; completionTokens: number; providerUsageDetails: unknown }
  assert.ok(usage.promptTokens > 0 && usage.completionTokens > 0)
  assert.deepEqual(usage.providerUsageDetails, { contextUsage: 120, contextWindow: 9216 })
  const [create] = control.creates
  assert.deepEqual(create.initialPrompts, [{ role: "system", content: "Be brief." }])
  assert.equal(create.topK, 3)
  assert.equal("tools" in create, false)
  assert.deepEqual(control.prompts[0].input, [{ role: "user", content: "Weather in Paris?" }])
  assert.equal(control.destroyed, 0, "kept for the thread's next step")
})

test("tools go in the system prompt; a fenced call ends the step with TOOL_CALL events and tool_calls", async () => {
  control.pieces = ["Checking. ", "```tool_call\n", '{"name": "get_weather", ', '"arguments": {"city": "Paris"}}\n', "```", "never read", "never read"]
  const chunks = await run({ tools: [weather], systemPrompts: ["Be brief."] })
  assert.match(String((control.creates[0].initialPrompts as Array<{ content: string }>)[0].content), /^Be brief\.\n\nYou are a helpful AI assistant with access to tools\.\n\n# Available Tools\n\[/)
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "RUN_FINISHED"
  ])
  assert.equal(textIn(chunks), "Checking. ")
  const end = chunks.find((c) => c.type === "TOOL_CALL_END")
  assert.equal(end?.toolCallName, "get_weather")
  assert.deepEqual(end?.input, { city: "Paris" })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  // Stopped at the closing fence (the stream reads at most one piece ahead).
  assert.ok(control.written <= 6, `wrote ${control.written} of 7 pieces`)
  assert.equal((control.prompts[0].options.signal as AbortSignal).aborted, true)
})

test("a call with no text before it sends no text message", async () => {
  control.pieces = ['```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```']
  const chunks = await run({ tools: [weather] })
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
})

test("toolChoice none leaves the tools out of the prompt", async () => {
  await run({ tools: [weather], toolChoice: "none", systemPrompts: ["Be brief."] })
  assert.deepEqual(control.creates[0].initialPrompts, [{ role: "system", content: "Be brief." }])
})

test("earlier calls are tool_call fences and their results one tool_result message", async () => {
  await run({
    tools: [weather],
    messages: [
      { role: "user", content: "Weather in Paris and Rome?" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
          { id: "c2", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }
        ]
      },
      { role: "tool", toolCallId: "c1", content: '{"temp":12}' },
      { role: "tool", toolCallId: "c2", content: "", error: "offline" }
    ]
  })
  assert.deepEqual(control.prompts[0].input, [
    { role: "user", content: "Weather in Paris and Rome?" },
    {
      role: "assistant",
      content:
        'Checking.\n```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"},"id":"c1"}\n{"name":"get_weather","arguments":{"city":"Rome"},"id":"c2"}\n```'
    },
    {
      role: "user",
      content:
        '```tool_result\n{"name":"get_weather","result":{"temp":12},"error":false,"id":"c1"}\n{"name":"get_weather","result":"offline","error":true,"id":"c2"}\n```'
    }
  ])
})

test("images are loaded as Blobs, and the session expects them", async () => {
  await run({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", content: "What's this?" },
          { type: "image", source: { type: "data", value: btoa("png"), mimeType: "image/png" } }
        ]
      }
    ]
  })
  assert.deepEqual(control.creates[0].expectedInputs, [{ type: "text", languages: ["en"] }, { type: "image" }])
  const [message] = control.prompts[0].input as Array<{ content: Array<{ type: string; value: unknown }> }>
  assert.equal(message.content[1].type, "image")
  assert.ok(message.content[1].value instanceof Blob)
})

test("a failure ends with RUN_ERROR, with the error's own message, and frees the session", async () => {
  control.promptFailure = new DOMException("too long", "QuotaExceededError")
  const chunks = await run()
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(chunks[1].message, "too long")
  assert.equal(control.destroyed, 1)

  control.promptFailure = undefined
  control.createFailure = new DOMException("click first", "NotAllowedError")
  assert.equal((await run()).at(-1)?.message, "click first")
})

test("an abort mid-reply ends the stream quietly and keeps the thread's session", async () => {
  for (const key of ["abortController", "request"] as const) {
    control.written = 0
    control.destroyed = 0
    const controller = new AbortController()
    control.pieces = ["a", "b", "c"]
    control.beforePiece = (index) => {
      if (index === 1) controller.abort(new Error("stop"))
    }
    const chunks = await run(key === "abortController" ? { abortController: controller } : { request: { signal: controller.signal } })
    assert.equal(textIn(chunks), "a")
    assert.ok(!chunks.some((c) => c.type === "RUN_FINISHED" || c.type === "RUN_ERROR"))
    // Chrome drops a stopped turn whole, so the session is still good.
    assert.equal(control.destroyed, 0)
  }
})

const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }
const structured = (extra: Record<string, unknown> = {}) => ({ chatOptions: chatOptions(extra), outputSchema: schema })

test("structured output: one prompt on the thread's session under responseConstraint, with the schema as given", async () => {
  const result = await promptApiText("built-in").structuredOutput(structured())
  assert.deepEqual(result.data, { city: "Tokyo" })
  assert.equal(result.rawText, '{"city":"Tokyo"}')
  assert.ok(result.usage)
  assert.equal(control.prompts.length, 1)
  assert.equal(control.prompts[0].options.responseConstraint, schema)
  assert.equal(control.destroyed, 0, "the thread keeps its session")

  const value = await chat({
    adapter: promptApiText("built-in"),
    threadId: "structured",
    messages: [{ role: "user", content: "Largest city?" }],
    outputSchema: schema
  })
  assert.deepEqual(value, { city: "Tokyo" })
})

test("structured output fails on an answer that isn't JSON, the browser's error, and an abort", async () => {
  control.answer = "Tokyo"
  await assert.rejects(promptApiText("built-in").structuredOutput(structured()), SyntaxError)
  control.promptFailure = new DOMException("unsupported schema", "NotSupportedError")
  await assert.rejects(promptApiText("built-in").structuredOutput(structured()), /unsupported schema/)
  const controller = new AbortController()
  controller.abort(new Error("stopped"))
  await assert.rejects(promptApiText("built-in").structuredOutput(structured({ abortController: controller })), /stopped/)
  assert.equal(control.destroyed, 3, "each failed session is freed")
})

test("availability is the browser's answer for the adapter's languages and inputs", async () => {
  let asked: unknown
  const api = (globalThis as unknown as { LanguageModel: { availability: (o: unknown) => Promise<string> } }).LanguageModel
  const original = api.availability
  api.availability = async (options) => {
    asked = options
    return "downloadable"
  }
  try {
    assert.equal(await promptApiText("built-in", { languages: ["ja"], inputs: ["audio"] }).availability(), "downloadable")
    assert.deepEqual(asked, { expectedInputs: [{ type: "text", languages: ["ja"] }, { type: "audio" }], expectedOutputs: [{ type: "text", languages: ["ja"] }] })
  } finally {
    api.availability = original
  }
})

test("create reports the download between 0 and 1, then 1, to both listeners, and frees its session", async () => {
  control.progress = [0, 0.5, 1]
  const own: Array<number> = []
  const call: Array<number> = []
  const adapter = promptApiText("built-in", { onDownloadProgress: (p) => own.push(p) })
  assert.equal(await adapter.create({ onDownloadProgress: (p) => call.push(p) }), adapter)
  assert.deepEqual(own, [0.5, 1])
  assert.deepEqual(call, [0.5, 1])
  assert.equal(control.destroyed, 1)

  control.createFailure = new DOMException("no", "NotSupportedError")
  await assert.rejects(adapter.create(), /no/)
})

/** A step on `adapter`, with these messages. */
async function step(adapter: ReturnType<typeof promptApiText>, messages: Array<unknown>, extra: Record<string, unknown> = {}) {
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.chatStream(chatOptions({ messages, ...extra }))) chunks.push(chunk as Chunk)
  return chunks
}

test("a thread's next step prompts its kept session with only the new messages", async () => {
  const adapter = promptApiText("built-in")
  const first = [{ role: "user", content: "Weather in Paris?" }]
  await step(adapter, first)
  await step(adapter, [...first, { role: "assistant", content: "Hello there" }, { role: "user", content: "And tomorrow?" }])
  assert.equal(control.creates.length, 1, "one session for the thread")
  assert.deepEqual(control.prompts[1].input, [{ role: "user", content: "And tomorrow?" }])
  assert.equal(control.destroyed, 0)
})

test("an edited conversation or new settings start the thread's session over", async () => {
  const adapter = promptApiText("built-in")
  await step(adapter, [{ role: "user", content: "Weather in Paris?" }])
  await step(adapter, [{ role: "user", content: "Weather in Rome?" }])
  assert.equal(control.creates.length, 2)
  assert.equal(control.destroyed, 1)
  assert.deepEqual(control.prompts[1].input, [{ role: "user", content: "Weather in Rome?" }])

  const rome = [{ role: "user", content: "Weather in Rome?" }, { role: "assistant", content: "Hello there" }, { role: "user", content: "And tomorrow?" }]
  await step(adapter, rome, { systemPrompts: ["Be brief."] })
  assert.equal(control.creates.length, 3, "a new system prompt is a new session")
  assert.equal((control.prompts[2].input as Array<unknown>).length, 3, "the whole conversation")
})

test("a step stopped at a tool call isn't in the session, so the next step sends it", async () => {
  const adapter = promptApiText("built-in")
  control.pieces = ['```tool_call\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```', " and more"]
  const asked = [{ role: "user", content: "Weather in Paris?" }]
  const chunks = await step(adapter, asked, { tools: [weather] })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  control.pieces = ["Sunny."]
  await step(
    adapter,
    [
      ...asked,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", toolCallId: "c1", content: '{"temperature":20}' }
    ],
    { tools: [weather] }
  )
  assert.equal(control.creates.length, 1, "the same session")
  const input = control.prompts[1].input as Array<{ role: string; content: string }>
  assert.deepEqual(input.map((m) => m.role), ["user", "assistant", "user"], "the question, the call and its result")
  assert.match(input[2].content, /```tool_result/)
})

test("a thread's session reports an overflow to onContextOverflow", async () => {
  const overflows: Array<string> = []
  await run({}, { onContextOverflow: (event) => overflows.push(event.type) })
  control.sessions.at(-1)?.dispatchEvent(new Event("contextoverflow"))
  assert.deepEqual(overflows, ["contextoverflow"])
})

test("past four threads the least recently used session closes, and destroy() closes the rest", async () => {
  const adapter = promptApiText("built-in")
  for (const thread of ["a", "b", "c", "d", "e"]) await step(adapter, [{ role: "user", content: "Hi" }], { threadId: thread })
  assert.equal(control.destroyed, 1, "thread a's")
  await adapter.destroy()
  assert.equal(control.destroyed, 5)
})

test("a call is emitted as it parses: chat() checks the tool and its arguments", async () => {
  control.pieces = ['```tool_call\n{"name": "weather", "arguments": {"town": "Paris"}}\n```']
  const chunks = await run({ tools: [weather] })
  const end = chunks.find((c) => c.type === "TOOL_CALL_END")
  assert.equal(end?.toolCallName, "weather")
  assert.deepEqual(end?.input, { town: "Paris" })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
})

test("a fence without a call is text, and the reply goes on", async () => {
  control.pieces = ["Hm. ", "```tool_call\nnope\n```", " Sunny."]
  const chunks = await run({ tools: [weather] })
  assert.equal(textIn(chunks), "Hm. ```tool_call\nnope\n``` Sunny.")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
})
