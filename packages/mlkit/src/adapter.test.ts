import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"

import { mlkitText } from "./adapter.js"
import type { MlKitNative, NativeAvailability, NativeEvent, NativeRequest } from "./native.js"

type Chunk = { type: string; [key: string]: unknown }
type Reply = NativeEvent extends infer E ? (E extends { requestId: string } ? Omit<E, "requestId"> : never) : never

const noop = () => undefined
const logger = { request: noop, provider: noop, errors: noop, warn: noop } as unknown as TextOptions["logger"]

/** A native side that answers each `generate` with scripted events. */
class FakeNative implements MlKitNative {
  calls: Array<[string, Record<string, unknown>]> = []
  answer: NativeAvailability = { status: "available", baseModelName: "nano-v4-full", tokenLimit: 4096, features: ["systemPrompt", "functionCalling"] }
  /** Events for each `generate`, in turn. */
  replies: Array<Array<Reply>> = []
  /** A download's progress, in bytes of 100. */
  progress: Array<number> = []
  /** `download` waits for this, when set. */
  downloaded: Promise<void> | undefined
  private listener: ((event: NativeEvent) => void) | undefined

  async availability(options?: Record<string, unknown>) {
    this.calls.push(["availability", options ?? {}])
    return this.answer
  }
  async addListener(_name: "event", listener: (event: NativeEvent) => void) {
    this.listener = listener
    return { remove: async () => undefined }
  }
  async download(options: { downloadId: string }) {
    this.calls.push(["download", options])
    for (const downloaded of this.progress) this.listener?.({ type: "download", downloadId: options.downloadId, downloaded, total: 100 })
    await this.downloaded
    this.answer = { ...this.answer, status: "available" }
  }
  async warmup(options?: Record<string, unknown>) {
    this.calls.push(["warmup", options ?? {}])
  }
  async countTokens(options: NativeRequest) {
    this.calls.push(["countTokens", options as unknown as Record<string, unknown>])
    return { totalTokens: 42 }
  }
  async generate(options: NativeRequest & { requestId: string }) {
    this.calls.push(["generate", options as unknown as Record<string, unknown>])
    const events = this.replies.shift() ?? [{ type: "done", text: "", finishReason: "stop" }]
    setTimeout(() => {
      for (const event of events) this.listener?.({ ...event, requestId: options.requestId } as NativeEvent)
    }, 1)
  }
  async cancel(options: Record<string, unknown>) {
    this.calls.push(["cancel", options])
  }
  named(name: string) {
    return this.calls.filter(([n]) => n === name).map(([, options]) => options)
  }
}

let native: FakeNative
beforeEach(() => {
  native = new FakeNative()
})

const weather = {
  name: "get_weather",
  description: "Weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
}
const user = (content: string) => ({ role: "user", content })

const chatOptions = (extra: Record<string, unknown> = {}) =>
  ({ model: "gemini-nano", logger, threadId: "thread", messages: [user("Weather in Paris?")], ...extra }) as unknown as TextOptions

async function run(adapter: ReturnType<typeof mlkitText>, extra: Record<string, unknown> = {}) {
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.chatStream(chatOptions(extra))) chunks.push(chunk as Chunk)
  return chunks
}
const typesOf = (chunks: Array<Chunk>) => chunks.map((c) => c.type)
const textIn = (chunks: Array<Chunk>) =>
  chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").map((c) => c.delta).join("")

test("a reply streams as text, from a request holding the system instruction, the tools and the settings", async () => {
  native.replies = [[{ type: "delta", text: "Hello " }, { type: "delta", text: "there" }, { type: "done", text: "Hello there", finishReason: "stop" }]]
  const chunks = await run(mlkitText({ native }), {
    systemPrompts: ["Be brief.", "Be kind."],
    tools: [weather],
    modelOptions: { temperature: 0.2, topK: 10, seed: 7, maxOutputTokens: 64 }
  })
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"])
  assert.equal(textIn(chunks), "Hello there")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
  const [request] = native.named("generate")
  assert.equal(request.systemInstruction, "Be brief.\n\nBe kind.")
  assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "Weather in Paris?" }] }])
  assert.deepEqual(request.tools, [
    { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }
  ])
  assert.deepEqual(request.options, { temperature: 0.2, topK: 10, seed: 7, maxOutputTokens: 64 })
  // ML Kit's default model: none named.
  assert.equal("model" in request, false)
})

const CALL_TEXT = "<ctrl42>call:get_weather{city:<ctrl46>Paris<ctrl46>}<ctrl43>"
const paris = { id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }

test("a tool call's own text, which ML Kit streams beside the call, stays out of the reply", async () => {
  native.replies = [
    [{ type: "delta", text: "<ctrl42>call:get_" }, { type: "delta", text: "weather{city:<ctrl46>Paris<ctrl46>}<ctrl43>" }, { type: "done", text: CALL_TEXT, finishReason: "stop", toolCalls: [paris] }],
    [{ type: "delta", text: "One moment. <ctr" }, { type: "delta", text: `l42>${CALL_TEXT.slice(8)}` }, { type: "done", text: `One moment. ${CALL_TEXT}`, finishReason: "stop", toolCalls: [paris] }]
  ]
  const adapter = mlkitText({ native })
  const only = await run(adapter, { tools: [weather] })
  assert.deepEqual(typesOf(only), ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
  const after = await run(adapter, { tools: [weather] })
  assert.equal(textIn(after), "One moment. ")
  assert.equal(after.at(-1)?.finishReason, "tool_calls")
})

test("text with the call's opening token and no call is written whole", async () => {
  native.replies = [[{ type: "delta", text: "The token <ctrl42> opens a call." }, { type: "done", text: "The token <ctrl42> opens a call.", finishReason: "stop" }]]
  assert.equal(textIn(await run(mlkitText({ native }))), "The token <ctrl42> opens a call.")
})

const reasoningIn = (chunks: Array<Chunk>) =>
  chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta).join("")

test("the thinking loses its opening label and a call's own text", async () => {
  native.replies = [
    [
      { type: "thought", text: "thou" },
      { type: "thought", text: "ght\nThe user wants " },
      { type: "thought", text: `the weather. ${CALL_TEXT}` },
      { type: "delta", text: CALL_TEXT },
      { type: "done", text: CALL_TEXT, finishReason: "stop", toolCalls: [paris] }
    ],
    [{ type: "thought", text: "thoughtful words" }, { type: "delta", text: "Hi" }, { type: "done", text: "Hi", finishReason: "stop" }],
    [{ type: "thought", text: "tho" }, { type: "delta", text: "Hi" }, { type: "done", text: "Hi", finishReason: "stop" }]
  ]
  const adapter = mlkitText({ native })
  const called = await run(adapter, { tools: [weather], reasoning: { level: "high" } })
  assert.equal(reasoningIn(called), "The user wants the weather. ")
  assert.equal(textIn(called), "")
  // Thinking that only starts like the label is kept whole.
  assert.equal(reasoningIn(await run(adapter, { reasoning: { level: "high" } })), "thoughtful words")
  assert.equal(reasoningIn(await run(adapter, { reasoning: { level: "high" } })), "tho")
})

test("the adapter's release stage and preference pick ML Kit's model, in every call", async () => {
  const adapter = mlkitText({ native, releaseStage: "preview", preference: "fast" })
  await adapter.availability()
  await run(adapter)
  assert.deepEqual(native.named("availability")[0], { model: { releaseStage: "preview", preference: "fast" } })
  assert.deepEqual(native.named("generate")[0].model, { releaseStage: "preview", preference: "fast" })
})

test("the model's tool calls end the step with tool_calls, after any text", async () => {
  native.replies = [
    [
      { type: "delta", text: "Let me check." },
      {
        type: "done",
        text: "Let me check.",
        finishReason: "stop",
        toolCalls: [
          { id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { id: "call_2", name: "get_weather", arguments: '{"city":"Rome"}' }
        ]
      }
    ]
  ]
  const chunks = await run(mlkitText({ native }), { tools: [weather] })
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "RUN_FINISHED"
  ])
  const ends = chunks.filter((c) => c.type === "TOOL_CALL_END")
  assert.deepEqual(ends.map((c) => [c.toolCallId, c.toolCallName, c.input]), [
    ["call_1", "get_weather", { city: "Paris" }],
    ["call_2", "get_weather", { city: "Rome" }]
  ])
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
})

test("chat() runs the tool and the next step sends the calls and their results as ML Kit's parts", async () => {
  native.replies = [
    [{ type: "done", text: "", finishReason: "stop", toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }] }],
    [{ type: "delta", text: "Sunny in Paris." }, { type: "done", text: "Sunny in Paris.", finishReason: "stop" }]
  ]
  const tool = { ...weather, execute: async ({ city }: { city: string }) => ({ city, sky: "sunny" }) }
  let text = ""
  for await (const chunk of chat({ adapter: mlkitText({ native }), threadId: "thread", messages: [user("Weather in Paris?")], tools: [tool] } as never) as AsyncIterable<Chunk>) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT") text += chunk.delta as string
  }
  assert.equal(text, "Sunny in Paris.")
  const [, second] = native.named("generate")
  assert.deepEqual(second.contents, [
    { role: "user", parts: [{ text: "Weather in Paris?" }] },
    { role: "model", parts: [{ functionCall: { id: "call_1", name: "get_weather", arguments: { city: "Paris" } } }] },
    { role: "user", parts: [{ functionResponse: { id: "call_1", name: "get_weather", response: { city: "Paris", sky: "sunny" } } }] }
  ])
  // The tools go with every request.
  assert.equal((second.tools as Array<unknown>).length, 1)
})

test("toolChoice none sends no tools, and a named tool sends only it", async () => {
  const other = { ...weather, name: "get_time" }
  const adapter = mlkitText({ native })
  await run(adapter, { tools: [weather, other], toolChoice: "none" })
  await run(adapter, { tools: [weather, other], toolChoice: { type: "function", name: "get_time" } })
  const [none, named] = native.named("generate")
  assert.equal("tools" in none, false)
  assert.deepEqual((named.tools as Array<{ name: string }>).map((t) => t.name), ["get_time"])
})

const holding = () => {
  native.answer = { ...native.answer, features: ["systemPrompt", "functionCalling", "structuredOutput"] }
}
const clock = { name: "get_time", description: "The time in a timezone", inputSchema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } }
const ping = { name: "ping", description: "Checks the connection", inputSchema: { type: "object", properties: {} } }
const callsIn = (chunks: Array<Chunk>) => chunks.filter((c) => c.type === "TOOL_CALL_END").map((c) => [c.toolCallName, c.input])

test("a named tool is called with an answer held to its parameters", async () => {
  holding()
  native.replies = [[{ type: "done", text: '{"city":"London"}', finishReason: "stop" }]]
  const chunks = await run(mlkitText({ native }), {
    messages: [user("Hi there")],
    tools: [weather, clock],
    toolChoice: { type: "function", name: "get_weather" },
    reasoning: { level: "high" },
    modelOptions: { temperature: 0.2 }
  })
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
  assert.deepEqual(callsIn(chunks), [["get_weather", { city: "London" }]])
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  const [request] = native.named("generate")
  assert.deepEqual(request.schema, weather.inputSchema)
  // Its declaration goes beside the schema, and the answer is the JSON alone: no thinking.
  assert.deepEqual((request.tools as Array<{ name: string }>).map((t) => t.name), ["get_weather"])
  assert.deepEqual(request.options, { temperature: 0.2 })
})

test("required picks a tool with an answer held to their names, then its arguments", async () => {
  holding()
  native.replies = [
    [{ type: "done", text: '{"tool":"get_time"}', finishReason: "stop" }],
    [{ type: "done", text: '{"timezone":"Asia/Tokyo"}', finishReason: "stop" }]
  ]
  const chunks = await run(mlkitText({ native }), { messages: [user("What time is it in Tokyo?")], tools: [weather, clock, ping], toolChoice: "required" })
  assert.deepEqual(callsIn(chunks), [["get_time", { timezone: "Asia/Tokyo" }]])
  const [pick, args] = native.named("generate")
  assert.deepEqual(pick.schema, {
    type: "object",
    properties: { tool: { type: "string", enum: ["get_weather", "get_time", "ping"], description: "The function to call" } },
    required: ["tool"]
  })
  assert.equal((pick.tools as Array<unknown>).length, 3)
  assert.deepEqual(args.schema, clock.inputSchema)
  assert.deepEqual((args.tools as Array<{ name: string }>).map((t) => t.name), ["get_time"])
})

test("a tool without parameters is called without asking for arguments, and one tool alone without a pick", async () => {
  holding()
  native.replies = [[{ type: "done", text: '{"tool":"ping"}', finishReason: "stop" }]]
  const adapter = mlkitText({ native })
  assert.deepEqual(callsIn(await run(adapter, { tools: [weather, ping], toolChoice: "required" })), [["ping", {}]])
  assert.equal(native.named("generate").length, 1)
  // One tool without parameters: nothing to ask the model.
  assert.deepEqual(callsIn(await run(adapter, { tools: [ping], toolChoice: "required" })), [["ping", {}]])
  assert.equal(native.named("generate").length, 1)
  // One tool with parameters: only its arguments.
  native.replies = [[{ type: "done", text: '{"city":"Paris"}', finishReason: "stop" }]]
  assert.deepEqual(callsIn(await run(adapter, { tools: [weather], toolChoice: "required" })), [["get_weather", { city: "Paris" }]])
  assert.equal(native.named("generate").length, 2)
})

test("an argument that isn't required and came as null is left out of a forced call", async () => {
  holding()
  const optional = { ...weather, inputSchema: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } }, required: ["city"] } }
  native.replies = [[{ type: "done", text: '{"city":"Paris","unit":null}', finishReason: "stop" }]]
  const chunks = await run(mlkitText({ native }), { tools: [optional], toolChoice: "required" })
  assert.deepEqual(callsIn(chunks), [["get_weather", { city: "Paris" }]])
  assert.equal(chunks.find((c) => c.type === "TOOL_CALL_END")?.args, '{"city":"Paris"}')
})

test("where the call can't be held, required is left to the model", async () => {
  // A model without structured output.
  native.replies = [[{ type: "delta", text: "Hello!" }, { type: "done", text: "Hello!", finishReason: "stop" }]]
  const adapter = mlkitText({ native })
  assert.equal(textIn(await run(adapter, { tools: [weather], toolChoice: "required" })), "Hello!")
  assert.equal("schema" in native.named("generate")[0], false)
  // A tool whose parameters ML Kit can't hold.
  holding()
  const loose = { ...weather, name: "lookup", inputSchema: { type: "object", properties: { id: { anyOf: [{ type: "string" }, { type: "integer" }] } } } }
  native.replies = [[{ type: "done", text: "", finishReason: "stop", toolCalls: [{ id: "call_1", name: "lookup", arguments: '{"id":7}' }] }]]
  assert.deepEqual(callsIn(await run(adapter, { tools: [weather, loose], toolChoice: "required" })), [["lookup", { id: 7 }]])
  const [, left] = native.named("generate")
  assert.equal("schema" in left, false)
  assert.equal((left.tools as Array<unknown>).length, 2)
})

test("a forced call's failure ends the run with its code, and a stop cancels it", async () => {
  holding()
  native.replies = [[{ type: "error", code: "busy", message: "Out of quota" }], [{ type: "error", code: "structuredOutputMaxTokensError", message: "FinishReason: 1" }]]
  const adapter = mlkitText({ native })
  assert.equal((await run(adapter, { tools: [weather], toolChoice: "required" })).at(-1)?.code, "busy")
  assert.equal((await run(adapter, { tools: [weather], toolChoice: "required" })).at(-1)?.code, "length")
  // A response that never ends.
  native.replies = [[{ type: "delta", text: "" }]]
  const abortController = new AbortController()
  setTimeout(() => abortController.abort(), 5)
  const stopped = await run(adapter, { tools: [weather], toolChoice: "required", abortController })
  assert.equal(stopped.at(-1)?.code, "aborted")
  assert.equal(native.named("cancel").length, 1)
})

test("thinking comes as reasoning events before the text, when reasoning is asked for", async () => {
  native.replies = [
    [
      { type: "thought", text: "The user " },
      { type: "thought", text: "greets me." },
      { type: "delta", text: "Hi!" },
      { type: "done", text: "Hi!", finishReason: "stop" }
    ]
  ]
  const chunks = await run(mlkitText({ native }), { reasoning: { level: "high" } })
  assert.deepEqual(typesOf(chunks), [
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
  assert.deepEqual(native.named("generate")[0].options, { enableThinking: true })
})

test("thinking is off unless asked for: reasoning off, or none", async () => {
  const adapter = mlkitText({ native })
  await run(adapter)
  await run(adapter, { reasoning: { level: "off" } })
  await run(adapter, { reasoning: { level: "off" }, modelOptions: { enableThinking: true } })
  assert.deepEqual(native.named("generate").map((r) => r.options), [{}, {}, { enableThinking: true }])
})

test("a response cut off at the token limit finishes with length", async () => {
  native.replies = [[{ type: "delta", text: "Once upon" }, { type: "done", text: "Once upon", finishReason: "length" }]]
  assert.equal((await run(mlkitText({ native }))).at(-1)?.finishReason, "length")
})

test("ML Kit's error ends the run with its code", async () => {
  native.replies = [[{ type: "error", code: "backgroundUseBlocked", message: "The app isn't in the foreground" }]]
  const chunks = await run(mlkitText({ native }))
  const last = chunks.at(-1) as Chunk
  assert.equal(last.type, "RUN_ERROR")
  assert.equal(last.code, "backgroundUseBlocked")
  assert.equal(last.message, "The app isn't in the foreground")
})

test("a stopped request cancels the native response and ends with aborted", async () => {
  // A response that never ends.
  native.replies = [[{ type: "delta", text: "Thinking" }]]
  const abortController = new AbortController()
  const chunks: Array<Chunk> = []
  for await (const chunk of mlkitText({ native }).chatStream(chatOptions({ abortController }))) {
    chunks.push(chunk as Chunk)
    if (chunk.type === "TEXT_MESSAGE_CONTENT") abortController.abort()
  }
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal(chunks.at(-1)?.code, "aborted")
  const [request] = native.named("generate")
  assert.deepEqual(native.named("cancel"), [{ requestId: request.requestId }])
})

test("a request stopped before it starts does no native work", async () => {
  const abortController = new AbortController()
  abortController.abort()
  const chunks = await run(mlkitText({ native }), { abortController })
  assert.equal(chunks.at(-1)?.code, "aborted")
  assert.deepEqual(native.named("generate"), [])
})

test("availability, the context size, the variant and the features come from ML Kit", async () => {
  const adapter = mlkitText({ native })
  assert.equal(await adapter.availability(), "available")
  assert.equal(await adapter.contextSize(), 4096)
  assert.deepEqual(await adapter.variant(), { baseModelName: "nano-v4-full", version: 4, displayName: "Gemini Nano 4" })
  assert.deepEqual(await adapter.features(), ["systemPrompt", "functionCalling"])
  native.answer = { status: "downloadable" }
  assert.equal(await adapter.availability(), "downloadable")
  assert.equal(await adapter.variant(), undefined)
  assert.deepEqual(await adapter.features(), [])
})

test("without the plugin (a browser, iOS) the model is unavailable", async () => {
  native.availability = async () => {
    throw new Error('"MlKit" plugin is not implemented on web')
  }
  const adapter = mlkitText({ native })
  assert.equal(await adapter.availability(), "unavailable")
  await assert.rejects(adapter.create(), /not implemented/)
})

test("create downloads a model that isn't on the device, with its progress, then loads it", async () => {
  native.answer = { status: "downloadable" }
  native.progress = [0, 25, 100]
  const heard: Array<number> = []
  const own: Array<number> = []
  const adapter = mlkitText({ native, onDownloadProgress: (p) => heard.push(p) })
  assert.equal(await adapter.create({ onDownloadProgress: (p) => own.push(p) }), adapter)
  // Under 1 until the model is ready.
  assert.deepEqual(heard, [0, 0.25, 0.999, 1])
  assert.deepEqual(own, heard)
  assert.deepEqual(native.calls.map(([name]) => name).filter((n) => n !== "availability"), ["download", "warmup"])
})

test("create only loads a model that's on the device, and rejects where there's none", async () => {
  const heard: Array<number> = []
  await mlkitText({ native }).create({ onDownloadProgress: (p) => heard.push(p) })
  assert.deepEqual(heard, [1])
  assert.deepEqual(native.named("download"), [])
  assert.equal(native.named("warmup").length, 1)
  native.answer = { status: "unavailable", reason: "aicoreIncompatible" }
  await assert.rejects(mlkitText({ native }).create(), (error: Error & { code?: string }) => error.code === "aicoreIncompatible")
})

test("create's signal stops the wait", async () => {
  native.answer = { status: "downloadable" }
  native.downloaded = new Promise(() => undefined)
  const controller = new AbortController()
  const ready = mlkitText({ native }).create({ signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(ready, { name: "AbortError" })
})

test("countTokens counts the conversation as it would be sent", async () => {
  const adapter = mlkitText({ native })
  assert.equal(await adapter.countTokens({ messages: [user("Hi")] as never, systemPrompts: ["Be brief."], tools: [weather] as never }), 42)
  const [request] = native.named("countTokens")
  assert.equal(request.systemInstruction, "Be brief.")
  assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "Hi" }] }])
  assert.equal((request.tools as Array<unknown>).length, 1)
})

test("destroy ends the responses streaming now", async () => {
  native.replies = [[{ type: "delta", text: "Thinking" }]]
  const adapter = mlkitText({ native })
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.chatStream(chatOptions())) {
    chunks.push(chunk as Chunk)
    if (chunk.type === "TEXT_MESSAGE_CONTENT") void adapter.destroy()
  }
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal(chunks.at(-1)?.code, "closed")
  assert.equal(native.named("cancel").length, 1)
})

const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
const structured = (extra: Record<string, unknown> = {}) => ({ outputSchema: schema, chatOptions: chatOptions(extra) }) as never

test("structured output puts the schema in the system instruction, after the caller's, and reads the answer as JSON", async () => {
  native.replies = [[{ type: "done", text: '```json\n{"city":"Paris"}\n```', finishReason: "stop" }], [{ type: "done", text: '{"city":"Rome"}', finishReason: "stop" }]]
  const adapter = mlkitText({ native })
  const result = await adapter.structuredOutput(structured({ tools: [weather], reasoning: { level: "high" }, systemPrompts: ["Be brief."] }))
  assert.deepEqual(result.data, { city: "Paris" })
  assert.equal(result.rawText, '{"city":"Paris"}')
  assert.deepEqual((await adapter.structuredOutput(structured())).data, { city: "Rome" })
  const [request, bare] = native.named("generate")
  const instruction = `Answer with one JSON value that is valid for this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`
  assert.equal(request.systemInstruction, `Be brief.\n\n${instruction}`)
  assert.equal(bare.systemInstruction, instruction)
  assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "Weather in Paris?" }] }])
  // The answer is the JSON alone: no tools, no thinking.
  assert.equal("tools" in request, false)
  assert.deepEqual(request.options, {})
})

test("where the model has structured output, ML Kit holds the answer to the schema", async () => {
  native.answer = { ...native.answer, features: ["systemPrompt", "structuredOutput"] }
  const optional = { type: "object", properties: { city: { type: "string" }, nickname: { type: "string" } }, required: ["city"] }
  native.replies = [[{ type: "done", text: '{"city":"Paris","nickname":null}', finishReason: "stop" }], [{ type: "done", text: '{"city":"Rome","nickname":"The Eternal City"}', finishReason: "stop" }]]
  const adapter = mlkitText({ native })
  const result = await adapter.structuredOutput({ outputSchema: optional, chatOptions: chatOptions({ systemPrompts: ["Be brief."], modelOptions: { maxOutputTokens: 64 } }) } as never)
  // The null ML Kit's schema allowed for the property that isn't required is left out.
  assert.deepEqual(result.data, { city: "Paris" })
  assert.equal(result.rawText, '{"city":"Paris"}')
  const [request] = native.named("generate")
  assert.deepEqual(request.schema, optional)
  // The schema is ML Kit's to write into the prompt: the system instruction is the caller's.
  assert.equal(request.systemInstruction, "Be brief.")
  assert.deepEqual(request.options, { maxOutputTokens: 64 })
  await mlkitText({ native, includeSchemaInPrompt: false }).structuredOutput({ outputSchema: optional, chatOptions: chatOptions() } as never)
  assert.deepEqual(native.named("generate")[1].options, { includeSchemaInPrompt: false })
})

test("a schema ML Kit can't hold, or a model without structured output, gets the schema in the prompt", async () => {
  const choice = { type: "object", properties: { id: { anyOf: [{ type: "string" }, { type: "integer" }] } }, required: ["id"] }
  native.answer = { ...native.answer, features: ["systemPrompt", "structuredOutput"] }
  native.replies = [[{ type: "done", text: '{"id":7}', finishReason: "stop" }]]
  assert.deepEqual((await mlkitText({ native }).structuredOutput({ outputSchema: choice, chatOptions: chatOptions() } as never)).data, { id: 7 })
  const [request] = native.named("generate")
  assert.equal("schema" in request, false)
  assert.match(request.systemInstruction as string, /valid for this JSON Schema/)
})

test("a held answer cut off at the token limit fails with length, as ML Kit's finish reason or its error says", async () => {
  native.answer = { ...native.answer, features: ["structuredOutput"] }
  native.replies = [
    [{ type: "done", text: "{}", finishReason: "length" }],
    [{ type: "error", code: "structuredOutputMaxTokensError", message: "Failed to parse JSON syntax. FinishReason: 1" }],
    [{ type: "error", code: "structuredOutputResponseError", message: "JSON structure does not match expected type Slot0." }]
  ]
  const adapter = mlkitText({ native })
  const code = (expected: string) => (error: Error & { code?: string }) => error.code === expected
  await assert.rejects(adapter.structuredOutput(structured()), code("length"))
  await assert.rejects(adapter.structuredOutput(structured()), code("length"))
  await assert.rejects(adapter.structuredOutput(structured()), code("structuredOutputResponseError"))
})

test("a structured answer that isn't JSON is a SyntaxError, and one cut off fails with length", async () => {
  native.replies = [[{ type: "done", text: "Paris, I think", finishReason: "stop" }], [{ type: "done", text: '{"city":"Pa', finishReason: "length" }]]
  const adapter = mlkitText({ native })
  await assert.rejects(adapter.structuredOutput(structured()), SyntaxError)
  await assert.rejects(adapter.structuredOutput(structured()), (error: Error & { code?: string }) => error.code === "length")
})
