import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"

import { promptApiText } from "./adapter.js"
import type { PromptApiConfig } from "./adapter.js"
import { PromptApiVariant } from "./variant.js"

type Chunk = { type: string; [key: string]: unknown }
type Prompt = { kind: "prompt" | "stream"; input: unknown; options: Record<string, unknown>; session: EventTarget }

const noop = () => undefined
const logger = { request: noop, provider: noop, errors: noop, warn: noop } as unknown as TextOptions["logger"]

/** What the fake browser does, per test. */
const control = {
  creates: [] as Array<Record<string, unknown>>,
  prompts: [] as Array<Prompt>,
  /** The streamed reply, in these pieces (text, or content such as a native tool call). */
  pieces: ["Hello ", "there"] as Array<string | { type: string; value: unknown }>,
  /** A structured answer (a prompt under responseConstraint). */
  answer: '{"city":"Tokyo"}',
  /** Structured answers in pieces, one list per prompt, before `answer`. */
  answers: [] as Array<Array<string>>,
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
  sessions: [] as Array<EventTarget>,
  /** measureContextUsage()'s calls: the input and the options. */
  measures: [] as Array<{ input: unknown; options?: Record<string, unknown> }>
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
  async measureContextUsage(input: unknown, options?: Record<string, unknown>) {
    control.measures.push({ input, ...(options && { options }) })
    return JSON.stringify(input).length
  }
  async prompt(input: unknown, options: Record<string, unknown> = {}) {
    control.prompts.push({ kind: "prompt", input, options, session: this })
    ;(options.signal as AbortSignal | undefined)?.throwIfAborted()
    if (control.promptFailure) throw control.promptFailure
    return control.answer
  }
  promptStreaming(input: unknown, options: Record<string, unknown> = {}) {
    control.prompts.push({ kind: "stream", input, options, session: this })
    const signal = options.signal as AbortSignal | undefined
    let index = 0
    // Under a schema, the structured answer; else the reply's pieces.
    const pieces = options.responseConstraint ? (control.answers.shift() ?? [control.answer]) : control.pieces
    return new ReadableStream<string | { type: string; value: unknown }>({
      pull(controller) {
        // An aborted signal first, as prompt() rejects: then the browser's own failure.
        if (signal?.aborted && index === 0) return controller.error(signal.reason)
        if (control.promptFailure) return controller.error(control.promptFailure)
        control.beforePiece(index)
        if (signal?.aborted) return controller.error(signal.reason)
        if (index >= pieces.length) return controller.close()
        control.written++
        controller.enqueue(pieces[index++])
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
    answers: [],
    createFailure: undefined,
    promptFailure: undefined,
    beforePiece: noop,
    written: 0,
    destroyed: 0,
    progress: [0, 1],
    sessions: [],
    measures: []
  })
})

const chatOptions = (extra: Record<string, unknown> = {}) =>
  ({
    model: "text",
    logger,
    threadId: "thread",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    ...extra
  }) as unknown as TextOptions

async function run(extra: Record<string, unknown> = {}, config: PromptApiConfig = {}) {
  const chunks: Array<Chunk> = []
  for await (const chunk of promptApiText("text", config).chatStream(chatOptions(extra))) chunks.push(chunk as Chunk)
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
  const system = String((control.creates[0].initialPrompts as Array<{ content: string }>)[0].content)
  assert.match(system, /^Be brief\.\n\nYou are a helpful AI assistant with access to tools\.\n\n# Available Tools\n\[/)
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

test("earlier calls are a tool_call fence and their results one tool_result message", async () => {
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
      content: 'Checking.\n```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"},"id":"c1"}\n{"name":"get_weather","arguments":{"city":"Rome"},"id":"c2"}\n```'
    },
    {
      role: "user",
      content: '```tool_result\n{"name":"get_weather","result":{"temp":12},"error":false,"id":"c1"}\n{"name":"get_weather","result":"offline","error":true,"id":"c2"}\n```'
    }
  ])
})

/** The browser's tool-use classes, as Chrome has them behind its tool-use flag: each keeps what it was made with. */
class FakeToolCall {
  constructor(readonly init: Record<string, unknown>) {}
  get name() {
    return this.init.name
  }
  get arguments() {
    return this.init.arguments
  }
  get callId() {
    return this.init.callId
  }
}
class FakeToolSuccess {
  constructor(readonly init: Record<string, unknown>) {}
}
class FakeToolError {
  constructor(readonly init: Record<string, unknown>) {}
}

/** Runs `body` in a browser with its own tool use. */
async function withToolUse(body: () => Promise<void>) {
  const g = globalThis as Record<string, unknown>
  Object.assign(g, { LanguageModelToolCall: FakeToolCall, LanguageModelToolSuccess: FakeToolSuccess, LanguageModelToolError: FakeToolError })
  try {
    await body()
  } finally {
    delete g.LanguageModelToolCall
    delete g.LanguageModelToolSuccess
    delete g.LanguageModelToolError
  }
}

test("with the browser's own tool use, the session declares the tools and the system prompt is the caller's alone", async () => {
  await withToolUse(async () => {
    control.pieces = ["Checking. ", { type: "tool-call", value: new FakeToolCall({ callId: "", name: "get_weather", arguments: { city: "Paris" } }) }]
    const chunks = await run({ tools: [weather], systemPrompts: ["Be brief."] })
    const [create] = control.creates
    assert.deepEqual(create.tools, [{ name: "get_weather", description: "Weather for a city", inputSchema: weather.inputSchema }])
    assert.deepEqual(create.initialPrompts, [{ role: "system", content: "Be brief." }], "no tool_code prompt")
    assert.deepEqual(create.expectedInputs, [{ type: "text", languages: ["en"] }, { type: "tool-call" }, { type: "tool-response" }])
    assert.deepEqual(create.expectedOutputs, [{ type: "text", languages: ["en"] }, { type: "tool-call" }])
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
    assert.ok(String(end?.toolCallId).length > 0, "an id where the browser gave none")
    assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
    assert.equal((control.prompts[0].options.signal as AbortSignal).aborted, false, "the turn runs to its end, so the session holds the call")
  })
})

test("the browser's own calls in one turn are each a tool call, with its id when it gives one", async () => {
  await withToolUse(async () => {
    control.pieces = [
      { type: "tool-call", value: new FakeToolCall({ callId: "b1", name: "get_weather", arguments: { city: "Paris" } }) },
      { type: "tool-call", value: new FakeToolCall({ callId: "b2", name: "get_weather", arguments: { city: "Rome" } }) }
    ]
    const chunks = await run({ tools: [weather] })
    const starts = chunks.filter((c) => c.type === "TOOL_CALL_START")
    assert.deepEqual(starts.map((c) => [c.toolCallId, c.index]), [["b1", 0], ["b2", 1]])
  })
})

test("with the browser's own tool use, earlier calls are tool-call content and results one message of tool-response content", async () => {
  await withToolUse(async () => {
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
        { role: "tool", toolCallId: "c1", content: '{"temp":12,"wind":null}' },
        { role: "tool", toolCallId: "c2", content: "", error: "offline" }
      ]
    })
    const [question, call, results] = control.prompts[0].input as Array<{ role: string; content: Array<{ type: string; value: { init: Record<string, unknown> } }> }>
    assert.deepEqual(question, { role: "user", content: "Weather in Paris and Rome?" })
    assert.equal(call.role, "assistant")
    assert.deepEqual(call.content[0], { type: "text", value: "Checking." })
    assert.ok(call.content[1].value instanceof FakeToolCall)
    assert.deepEqual(call.content[1].value.init, { callId: "c1", callID: "c1", name: "get_weather", arguments: { city: "Paris" } })
    assert.equal(results.role, "user")
    assert.deepEqual(results.content.map((part) => part.type), ["tool-response", "tool-response"])
    assert.ok(results.content[0].value instanceof FakeToolSuccess)
    assert.deepEqual(results.content[0].value.init, { callId: "c1", callID: "c1", name: "get_weather", result: [{ type: "object", value: { temp: 12 } }] })
    assert.ok(results.content[1].value instanceof FakeToolError)
    assert.deepEqual(results.content[1].value.init, { callId: "c2", callID: "c2", name: "get_weather", errorMessage: "offline" })
  })
})

test("without the browser's own tool use, tools go by prompt", async () => {
  control.pieces = ['```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```']
  const chunks = await run({ tools: [weather] })
  assert.equal("tools" in control.creates[0], false)
  assert.equal(chunks.find((c) => c.type === "TOOL_CALL_END")?.toolCallName, "get_weather")
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

test("an abort mid-reply ends with RUN_ERROR (code aborted) and keeps the thread's session", async () => {
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
    assert.ok(!chunks.some((c) => c.type === "RUN_FINISHED"))
    assert.equal((chunks.at(-1)?.error as { code?: string } | undefined)?.code, "aborted")
    // Chrome drops a stopped turn whole, so the session is still good.
    assert.equal(control.destroyed, 0)
  }
})

const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }
const structured = (extra: Record<string, unknown> = {}) => ({ chatOptions: chatOptions(extra), outputSchema: schema })

test("structured output: one prompt on the thread's session under responseConstraint, with the schema as given", async () => {
  const result = await promptApiText("text").structuredOutput(structured())
  assert.deepEqual(result.data, { city: "Tokyo" })
  assert.equal(result.rawText, '{"city":"Tokyo"}')
  assert.equal(control.prompts.length, 1)
  assert.equal(control.prompts[0].options.responseConstraint, schema)
  assert.equal(control.destroyed, 0, "the thread keeps its session")

  const value = await chat({
    adapter: promptApiText("text"),
    threadId: "structured",
    messages: [{ role: "user", content: "Largest city?" }],
    outputSchema: schema
  })
  assert.deepEqual(value, { city: "Tokyo" })
})

test("structured output fails on an answer that isn't JSON, the browser's error, and an abort", async () => {
  control.answer = "Tokyo"
  await assert.rejects(promptApiText("text").structuredOutput(structured()), SyntaxError)
  control.promptFailure = new DOMException("unsupported schema", "NotSupportedError")
  await assert.rejects(promptApiText("text").structuredOutput(structured()), /unsupported schema/)
  const controller = new AbortController()
  controller.abort(new Error("stopped"))
  await assert.rejects(promptApiText("text").structuredOutput(structured({ abortController: controller })), /stopped/)
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
    assert.equal(await promptApiText("text", { languages: ["ja"], inputs: ["audio"] }).availability(), "downloadable")
    assert.deepEqual(asked, { expectedInputs: [{ type: "text", languages: ["ja"] }, { type: "audio" }], expectedOutputs: [{ type: "text", languages: ["ja"] }] })
  } finally {
    api.availability = original
  }
})

test("variant guesses the model from the browser and Chrome's tool-use classes, without making a session", async () => {
  const g = globalThis as unknown as { navigator?: unknown; LanguageModelToolCall?: unknown }
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const browser = (brands: Array<string>, userAgent = "Mozilla/5.0") =>
    Object.defineProperty(globalThis, "navigator", { value: { userAgent, userAgentData: { brands: brands.map((brand) => ({ brand })) } }, configurable: true })
  const api = (globalThis as unknown as { LanguageModel: { availability: () => Promise<string> } }).LanguageModel
  const availability = api.availability
  const creates = control.creates.length
  try {
    browser(["Not)A;Brand", "Microsoft Edge", "Chromium"])
    assert.equal(await promptApiText().variant(), PromptApiVariant.aion1_1)
    browser(["Google Chrome", "Chromium"])
    assert.equal((await promptApiText().variant())?.displayName, "Gemini Nano")
    g.LanguageModelToolCall = class {}
    assert.equal(await promptApiText().variant(), PromptApiVariant.gemma4)
    browser([], "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36 Edg/159.0.0.0")
    assert.equal(await promptApiText().variant(), PromptApiVariant.aion1_1, "the user agent, without client hints")
    delete g.LanguageModelToolCall
    browser(["Chromium"])
    assert.equal(await promptApiText().variant(), undefined, "a browser it can't tell")
    browser(["Google Chrome"])
    api.availability = async () => "unavailable"
    assert.equal(await promptApiText().variant(), undefined, "the Prompt API can't run here")
    assert.equal(control.creates.length, creates, "no session")
  } finally {
    api.availability = availability
    delete g.LanguageModelToolCall
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else delete g.navigator
  }
})

test("availableInputModalities asks the browser about each kind of input: what it doesn't make unavailable", async () => {
  const asked: Array<unknown> = []
  const api = (globalThis as unknown as { LanguageModel: { availability: (o: { expectedInputs: Array<{ type: string }> }) => Promise<string> } }).LanguageModel
  const original = api.availability
  // Images on the device, audio not on this one (it needs a GPU).
  api.availability = async (options) => {
    asked.push(options.expectedInputs)
    return options.expectedInputs.some((input) => input.type === "audio") ? "unavailable" : "available"
  }
  try {
    // As an app makes it: no inputs given.
    const adapter = promptApiText({ languages: ["ja"] })
    assert.deepEqual(await adapter.availableInputModalities(), ["text", "image"])
    assert.deepEqual(asked, [
      [{ type: "text", languages: ["ja"] }],
      [{ type: "text", languages: ["ja"] }, { type: "image" }],
      [{ type: "text", languages: ["ja"] }, { type: "audio" }]
    ])
    // No model at all: nothing.
    api.availability = async () => "unavailable"
    assert.deepEqual(await adapter.availableInputModalities(), [])
  } finally {
    api.availability = original
  }
})

test("create reports the download between 0 and 1, then 1, to both listeners, and frees its session", async () => {
  control.progress = [0, 0.5, 1]
  const own: Array<number> = []
  const call: Array<number> = []
  const adapter = promptApiText("text", { onDownloadProgress: (p) => own.push(p) })
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
  const adapter = promptApiText("text")
  const first = [{ role: "user", content: "Weather in Paris?" }]
  await step(adapter, first)
  await step(adapter, [...first, { role: "assistant", content: "Hello there" }, { role: "user", content: "And tomorrow?" }])
  assert.equal(control.creates.length, 1, "one session for the thread")
  assert.deepEqual(control.prompts[1].input, [{ role: "user", content: "And tomorrow?" }])
  assert.equal(control.destroyed, 0)
})

test("an edited conversation or new settings start the thread's session over", async () => {
  const adapter = promptApiText("text")
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
  const adapter = promptApiText("text")
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

test("contextUsage and contextWindow are the thread's session's own; undefined without a session", async () => {
  const adapter = promptApiText("text")
  assert.equal(await adapter.contextUsage(), undefined)
  assert.equal(await adapter.contextWindow("a"), undefined)
  await step(adapter, [{ role: "user", content: "Hi" }], { threadId: "a" })
  await step(adapter, [{ role: "user", content: "Hi" }], { threadId: "b" })
  Object.assign(control.sessions[0], { contextUsage: 300 })
  assert.equal(await adapter.contextUsage("a"), 300)
  assert.equal(await adapter.contextUsage(), 120, "the thread used last")
  assert.equal(await adapter.contextWindow("a"), 9216)
  assert.equal(await adapter.contextUsage("c"), undefined)
  await adapter.destroy()
  assert.equal(await adapter.contextUsage("a"), undefined)
})

test("past four threads the least recently used session closes, and destroy() closes the rest", async () => {
  const adapter = promptApiText("text")
  for (const thread of ["a", "b", "c", "d", "e"]) await step(adapter, [{ role: "user", content: "Hi" }], { threadId: thread })
  assert.equal(control.destroyed, 1, "thread a's")
  await adapter.destroy()
  assert.equal(control.destroyed, 5)
})

test("a call is emitted as it parses: chat() checks its arguments", async () => {
  control.pieces = ['```tool_call\n{"name": "get_weather", "arguments": {"town": "Paris"}}\n```']
  const chunks = await run({ tools: [weather] })
  const end = chunks.find((c) => c.type === "TOOL_CALL_END")
  assert.equal(end?.toolCallName, "get_weather")
  assert.deepEqual(end?.input, { town: "Paris" })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
})

test("toolChoice none runs no tool, even when the model writes a call", async () => {
  let runs = 0
  const tool = { ...weather, execute: async () => ++runs }
  control.pieces = ['```tool_call\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```']
  const result = await chat({
    adapter: promptApiText("text"),
    threadId: "none",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    tools: [tool],
    toolChoice: "none",
    stream: false
  })
  assert.equal(runs, 0)
  assert.match(result.text, /tool_call/, "the call is text")
})

test("a call to a tool the step doesn't offer is text, not a call", async () => {
  control.pieces = ['```tool_call\n{"name": "delete_files", "arguments": {}}\n```']
  const chunks = await run({ tools: [weather] })
  assert.ok(!chunks.some((c) => c.type.startsWith("TOOL_CALL")))
  assert.equal(chunks.at(-1)?.finishReason, "stop")

  control.pieces = ['```tool_call\n{"name": "get_weather", "arguments": {}}\n```']
  const forced = await run({ tools: [weather, { ...weather, name: "clock" }], toolChoice: { type: "tool", name: "clock" } })
  assert.ok(!forced.some((c) => c.type.startsWith("TOOL_CALL")), "only the chosen tool")
})

/** Every chunk of these steps, run at the same time. */
const together = (...steps: Array<AsyncIterable<unknown>>) =>
  Promise.all(
    steps.map(async (s) => {
      const chunks: Array<Chunk> = []
      for await (const chunk of s) chunks.push(chunk as Chunk)
      return chunks
    })
  )

test("overlapping steps on a warm thread get sessions of their own", async () => {
  const adapter = promptApiText("text")
  const first = [{ role: "user", content: "Weather in Paris?" }]
  await step(adapter, first)
  const next = [...first, { role: "assistant", content: "Hello there" }, { role: "user", content: "And tomorrow?" }]
  await together(adapter.chatStream(chatOptions({ messages: next })), adapter.chatStream(chatOptions({ messages: next })))
  assert.notEqual(control.prompts[1].session, control.prompts[2].session, "never the same session at once")
  await adapter.destroy()
  assert.equal(control.destroyed, control.creates.length, "every session closed")
})

test("overlapping steps on a cold thread: destroy() closes every session", async () => {
  const adapter = promptApiText("text")
  await together(adapter.chatStream(chatOptions()), adapter.chatStream(chatOptions()))
  await adapter.destroy()
  assert.equal(control.creates.length, 2)
  assert.equal(control.destroyed, 2)
})

test("promptCache retention none closes the session after the step; a key names the session to keep", async () => {
  await run({ promptCache: { retention: "none" } })
  assert.equal(control.destroyed, 1)

  const adapter = promptApiText("text")
  const first = [{ role: "user", content: "Weather in Paris?" }]
  const promptCache = { retention: "short", key: "shared" }
  await step(adapter, first, { threadId: "a", promptCache })
  await step(adapter, [...first, { role: "assistant", content: "Hello there" }, { role: "user", content: "And tomorrow?" }], { threadId: "b", promptCache })
  assert.equal(control.creates.length, 2, "thread b goes on from the keyed session")
})

test("a fence without a call is text, and the reply goes on", async () => {
  control.pieces = ["Hm. ", "```tool_call\nnope\n```", " Sunny."]
  const chunks = await run({ tools: [weather] })
  assert.equal(textIn(chunks), "Hm. ```tool_call\nnope\n``` Sunny.")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
})

test("the model is optional: promptApiText() and promptApiText(config) are the browser's built-in model", () => {
  assert.equal(promptApiText().model, "text")
  assert.equal(promptApiText({ languages: ["en"] }).model, "text")
  assert.equal(promptApiText("text", {}).model, "text")
})

/** The fake session's count of an input: `measureContextUsage`. */
const measured = (input: unknown) => JSON.stringify(input).length
const usageOf = (chunk: Chunk | undefined) =>
  (chunk as { usage?: { promptTokens: number; completionTokens: number; totalTokens: number; promptTokensDetails?: { cachedTokens?: number } } } | undefined)?.usage

test("a reply reports its tokens: what the session held, and the prompt and the reply as the session measures them", async () => {
  const adapter = promptApiText("text")
  const step = async (messages: Array<Record<string, unknown>>) => {
    const chunks: Array<Chunk> = []
    for await (const chunk of adapter.chatStream(chatOptions({ messages }))) chunks.push(chunk as Chunk)
    return usageOf(chunks.at(-1))
  }
  const first = [{ role: "user", content: "Weather in Paris?" }]
  const prompt = 120 + measured(first)
  // Less an empty message's count: the turn markers a session counts around any message.
  const reply = measured("Hello there") - measured("")
  // A new session read what it holds in this step: nothing cached, so no cached count (as TanStack reports it).
  assert.deepEqual(await step(first), { promptTokens: prompt, completionTokens: reply, totalTokens: prompt + reply })

  // The thread's kept session doesn't read what it holds again: only the new message.
  Object.assign(control.sessions[0], { contextUsage: 300 })
  const next = [...first, { role: "assistant", content: "Hello there" }, { role: "user", content: "And tomorrow?" }]
  const usage = await step(next)
  assert.equal(control.creates.length, 1, "the same session")
  assert.equal(usage?.promptTokens, 300 + measured([{ role: "user", content: "And tomorrow?" }]))
  assert.deepEqual(usage?.promptTokensDetails, { cachedTokens: 300 })
})

test("a step stopped at a tool call counts everything the model wrote, the call included", async () => {
  control.pieces = ["Checking. ", '```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```']
  const chunks = await run({ tools: [weather] })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  assert.equal(usageOf(chunks.at(-1))?.completionTokens, measured(control.pieces.join("")) - measured(""))
})

test("structured output reports its tokens too", async () => {
  const result = await promptApiText("text").structuredOutput(structured())
  assert.equal(result.usage?.completionTokens, measured('{"city":"Tokyo"}') - measured(""))
  assert.equal(result.usage?.promptTokens, 120 + measured([{ role: "user", content: "Weather in Paris?" }]))
})

test("a browser that can't measure reports no usage, and the reply still ends", async () => {
  const measure = FakeSession.prototype.measureContextUsage
  FakeSession.prototype.measureContextUsage = async () => {
    throw new Error("measureContextUsage isn't supported")
  }
  try {
    const chunks = await run()
    assert.equal(chunks.at(-1)?.type, "RUN_FINISHED")
    assert.equal(usageOf(chunks.at(-1)), undefined)
    assert.equal(textIn(chunks), "Hello there")
  } finally {
    FakeSession.prototype.measureContextUsage = measure
  }
})

test("omitResponseConstraintInput: off by default, so the prompt gets the schema and the signal only", async () => {
  await promptApiText("text").structuredOutput(structured())
  const { options } = control.prompts[0]
  assert.equal(options.responseConstraint, schema)
  assert.equal("omitResponseConstraintInput" in options, false)
})

test("omitResponseConstraintInput: a request's option, or the adapter's, goes to the prompt next to the schema; a request's false wins", async () => {
  await promptApiText("text").structuredOutput(structured({ threadId: "a", modelOptions: { omitResponseConstraintInput: true } }))
  assert.equal(control.prompts.at(-1)?.options.omitResponseConstraintInput, true)
  const omitting = promptApiText("text", { omitResponseConstraintInput: true })
  await omitting.structuredOutput(structured({ threadId: "b" }))
  assert.equal(control.prompts.at(-1)?.options.omitResponseConstraintInput, true)
  await omitting.structuredOutput(structured({ threadId: "c", modelOptions: { omitResponseConstraintInput: false } }))
  assert.equal("omitResponseConstraintInput" in (control.prompts.at(-1)?.options ?? {}), false)
})

test("omitResponseConstraintInput is never sent without a schema", async () => {
  const adapter = promptApiText("text", { omitResponseConstraintInput: true })
  for await (const _ of adapter.chatStream(chatOptions({ modelOptions: { omitResponseConstraintInput: true } }))) void _
  const stream = control.prompts.find((p) => p.kind === "stream")
  assert.ok(stream)
  assert.equal("omitResponseConstraintInput" in stream.options, false)
  assert.equal("responseConstraint" in stream.options, false)
})

test("omitResponseConstraintInput: streaming structured output sends it like the promise does", async () => {
  const chunks: Array<Chunk> = []
  for await (const chunk of chat({
    adapter: promptApiText("text"),
    threadId: "streamed",
    messages: [{ role: "user", content: "Largest city?" }],
    outputSchema: schema,
    stream: true,
    modelOptions: { omitResponseConstraintInput: true }
  } as never) as unknown as AsyncIterable<Chunk>) chunks.push(chunk)
  const constrained = control.prompts.find((p) => p.options.responseConstraint)
  assert.equal(constrained?.options.omitResponseConstraintInput, true)
  assert.ok(chunks.some((c) => c.type === "CUSTOM"))
})

test("omitResponseConstraintInput is a prompt's, not the session's: it doesn't carry over to the thread's next prompt", async () => {
  const adapter = promptApiText("text")
  await adapter.structuredOutput(structured({ threadId: "kept", modelOptions: { omitResponseConstraintInput: true } }))
  await adapter.structuredOutput(
    structured({
      threadId: "kept",
      messages: [{ role: "user", content: "Weather in Paris?" }, { role: "assistant", content: '{"city":"Tokyo"}' }, { role: "user", content: "And tomorrow?" }]
    })
  )
  assert.equal(control.prompts.length, 2)
  assert.equal(control.prompts[0].session, control.prompts[1].session, "the thread keeps its session")
  assert.equal(control.prompts[0].options.omitResponseConstraintInput, true)
  assert.equal("omitResponseConstraintInput" in control.prompts[1].options, false)
})

test("usage measures the input with the prompt's options: a schema Chrome writes into the input counts", async () => {
  await promptApiText("text").structuredOutput(structured({ modelOptions: { omitResponseConstraintInput: true } }))
  const measured = control.measures.find((m) => m.options?.responseConstraint)
  assert.ok(measured, "the input is measured with the schema")
  assert.equal(measured.options?.omitResponseConstraintInput, true)
})

test("a structured answer that runs away in whitespace is stopped, and asked again once", async () => {
  const runaway = ['{"cards":[{"name":"a"}', ...Array.from({ length: 20 }, () => "    \n"), "never read"]
  control.answers = [runaway, ['{"city":', ' "Tokyo"}']]
  const result = await promptApiText("text").structuredOutput(structured())
  assert.deepEqual(result.data, { city: "Tokyo" })
  assert.equal(control.prompts.length, 2, "asked again once")
  assert.equal((control.prompts[0].options.signal as AbortSignal).aborted, true, "the runaway was stopped")
  // Twice: a clear error, with code "runaway".
  control.answers = [runaway, runaway]
  await assert.rejects(promptApiText("text").structuredOutput(structured({ threadId: "again" })), (e: Error & { code?: string }) => e.code === "runaway" && /whitespace without end/.test(e.message))
})

test("whitespace inside a string, and JSON's ordinary spacing, aren't a runaway", async () => {
  control.answers = [['{"city": "', " ".repeat(200), '",', "\n  ", '"x": 1}']]
  const result = await promptApiText("text").structuredOutput({ chatOptions: chatOptions(), outputSchema: { type: "object" } } as never)
  assert.deepEqual(result.data, { city: " ".repeat(200), x: 1 })
  assert.equal(control.prompts.length, 1)
})

test("maxOutputTokens stops a reply at that many streamed pieces (a token each), finishing with length", async () => {
  control.pieces = Array.from({ length: 40 }, () => "word ")
  const events: Array<Chunk> = []
  for await (const event of promptApiText("text").chatStream(chatOptions({ modelOptions: { maxOutputTokens: 30 } }))) events.push(event as Chunk)
  const finished = events.find((e) => e.type === "RUN_FINISHED") as Chunk & { finishReason?: string }
  assert.equal(finished.finishReason, "length")
  assert.ok(control.written < 40, `${control.written} pieces read`)
  assert.equal(events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").length, 30, "stopped at the 30th piece")
  // The cap never measures mid-reply (Chrome would wait for the reply to end): only the usage's own measures.
  control.measures = []
  control.written = 0
  control.pieces = Array.from({ length: 40 }, () => "word ")
  for await (const _ of promptApiText("text", { maxOutputTokens: 30 }).chatStream(chatOptions({ threadId: "short" }))) void _
  assert.equal(control.measures.length, 3, "the usage's three measures, after the reply")
})

test("maxOutputTokens cuts a structured answer off with code length; the adapter's applies to every call", async () => {
  control.answers = [['{"cities":[', ...Array.from({ length: 30 }, (_, i) => `"city${i}",`), '"last"]}']]
  await assert.rejects(
    promptApiText("text", { maxOutputTokens: 20 }).structuredOutput({ chatOptions: chatOptions(), outputSchema: { type: "object" } } as never),
    (e: Error & { code?: string }) => e.code === "length" && /maxOutputTokens \(20\)/.test(e.message)
  )
})
