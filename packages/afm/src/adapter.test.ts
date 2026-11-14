import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import type { TextOptions } from "@tanstack/ai"

import { afmText } from "./adapter.js"
import type { AfmNative, NativeAvailability, NativeEvent } from "./native.js"

type Chunk = { type: string; [key: string]: unknown }
type Event = NativeEvent extends infer E ? (E extends unknown ? Omit<E, "sessionId" | "turn"> : never) : never

const noop = () => undefined
const logger = { request: noop, provider: noop, errors: noop, warn: noop } as unknown as TextOptions["logger"]

/** A native side that answers each `respond`, and each set of tool results, with scripted events. */
class FakeNative implements AfmNative {
  calls: Array<[string, Record<string, unknown>]> = []
  answer: NativeAvailability = { available: true, contextSize: 4096 }
  /** Events for each `respond`, in turn. */
  replies: Array<Array<Event>> = []
  /** Events once a response's waiting tool calls all have results, in turn. */
  resumes: Array<Array<Event>> = []
  private listener: ((event: NativeEvent) => void) | undefined
  private turns = new Map<string, number>()
  private waiting = new Map<string, Set<string>>()

  async availability() {
    return this.answer
  }
  async addListener(_name: "event", listener: (event: NativeEvent) => void) {
    this.listener = listener
    return { remove: async () => undefined }
  }
  async createSession(options: Record<string, unknown>) {
    this.calls.push(["createSession", options])
  }
  async prewarm(options: Record<string, unknown>) {
    this.calls.push(["prewarm", options])
  }
  async respond(options: { sessionId: string; turn: number } & Record<string, unknown>) {
    this.calls.push(["respond", options])
    this.turns.set(options.sessionId, options.turn)
    this.play(options.sessionId, this.replies.shift() ?? [{ type: "done", text: "" }])
  }
  async submitToolResult(options: { sessionId: string; callId: string; output: string }) {
    this.calls.push(["submitToolResult", options])
    const waiting = this.waiting.get(options.sessionId)
    waiting?.delete(options.callId)
    if (waiting?.size === 0) this.play(options.sessionId, this.resumes.shift() ?? [{ type: "done", text: "" }])
  }
  async cancel(options: Record<string, unknown>) {
    this.calls.push(["cancel", options])
  }
  async deleteSession(options: Record<string, unknown>) {
    this.calls.push(["deleteSession", options])
  }
  private play(sessionId: string, events: Array<Event>) {
    const turn = this.turns.get(sessionId) ?? 0
    setTimeout(() => {
      for (const event of events) {
        if (event.type === "toolCalls") this.waiting.set(sessionId, new Set(event.calls.map((c) => c.id)))
        this.listener?.({ ...event, sessionId, turn } as NativeEvent)
      }
    }, 1)
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
  ({ model: "system", logger, threadId: "thread", messages: [user("Weather in Paris?")], ...extra }) as unknown as TextOptions

async function run(adapter: ReturnType<typeof afmText>, extra: Record<string, unknown> = {}) {
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.chatStream(chatOptions(extra))) chunks.push(chunk as Chunk)
  return chunks
}
const typesOf = (chunks: Array<Chunk>) => chunks.map((c) => c.type)
const textIn = (chunks: Array<Chunk>) =>
  chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").map((c) => c.delta).join("")

test("cached tokens pass through where the bridge counts them, none included", async () => {
  const adapter = afmText({ native })
  for (const cachedTokens of [0, 2890]) {
    native.replies = [[{ type: "done", text: "Hi", usage: { inputTokens: 2907, cachedTokens, outputTokens: 2 } }]]
    const chunks = await run(adapter, { threadId: `cached-${cachedTokens}` })
    assert.deepEqual((chunks.at(-1)?.usage as Record<string, unknown>).promptTokensDetails, { cachedTokens })
  }
})

test("a reply streams as text from a new session holding the instructions and tools", async () => {
  native.replies = [[{ type: "delta", text: "Hello " }, { type: "delta", text: "there" }, { type: "done", text: "Hello there", usage: { inputTokens: 120, outputTokens: 4 } }]]
  const adapter = afmText({ native })
  const chunks = await run(adapter, { systemPrompts: ["Be brief."], tools: [weather], modelOptions: { temperature: 0.2 } })
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"])
  assert.equal(textIn(chunks), "Hello there")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
  assert.deepEqual((chunks.at(-1)?.usage as Record<string, unknown>).promptTokens, 120)
  // With tools, the framework's cached count is wrong, and the bridge sends none.
  assert.equal((chunks.at(-1)?.usage as Record<string, unknown>).promptTokensDetails, undefined)
  const [session] = native.named("createSession")
  // The system prompt, then when to call tools (the session has one).
  assert.match(session.instructions as string, /^Be brief\.\n\nMost requests need no tool/)
  assert.deepEqual(session.messages, [])
  assert.deepEqual(session.tools, [
    {
      name: "get_weather",
      description: "Weather for a city",
      parameters: {
        root: { kind: "object", name: "get_weather", properties: [{ name: "city", optional: false, schema: { kind: "string" } }] },
        definitions: []
      }
    }
  ])
  const [respond] = native.named("respond")
  assert.equal(respond.prompt, "Weather in Paris?")
  assert.deepEqual(respond.options, { temperature: 0.2 })
  assert.equal(native.named("deleteSession").length, 0, "kept for the thread's next step")
})

test("a tool call ends the step with tool_calls while the response waits, and the next step resumes it with the result", async () => {
  native.replies = [[{ type: "toolCalls", calls: [{ id: "call-1", name: "get_weather", arguments: '{"city": "Paris"}' }] }]]
  native.resumes = [[{ type: "delta", text: "Sunny in Paris." }, { type: "done", text: "Sunny in Paris." }]]
  const adapter = afmText({ native })
  const first = await run(adapter, { tools: [weather] })
  assert.deepEqual(typesOf(first), ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
  const end = first.find((c) => c.type === "TOOL_CALL_END")
  assert.equal(end?.toolCallId, "call-1")
  assert.deepEqual(end?.input, { city: "Paris" })
  assert.equal(first.at(-1)?.finishReason, "tool_calls")

  const messages = [
    user("Weather in Paris?"),
    { role: "assistant", content: null, toolCalls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city": "Paris"}' } }] },
    { role: "tool", toolCallId: "call-1", content: '{"temperature": 21}' }
  ]
  const second = await run(adapter, { tools: [weather], messages })
  assert.equal(textIn(second), "Sunny in Paris.")
  assert.equal(second.at(-1)?.finishReason, "stop")
  assert.deepEqual(native.named("submitToolResult"), [{ sessionId: native.named("createSession")[0].sessionId, callId: "call-1", output: '{"temperature": 21}' }])
  assert.equal(native.named("createSession").length, 1, "the same session")
  assert.equal(native.named("respond").length, 1, "the same response")
})

test("parallel calls are one step; results for only some of them start a new session from the messages", async () => {
  const calls = [
    { id: "a", name: "get_weather", arguments: '{"city": "Tokyo"}' },
    { id: "b", name: "get_weather", arguments: '{"city": "London"}' }
  ]
  native.replies = [[{ type: "toolCalls", calls }], [{ type: "done", text: "Partial." }]]
  const adapter = afmText({ native })
  const first = await run(adapter, { tools: [weather] })
  assert.equal(first.filter((c) => c.type === "TOOL_CALL_END").length, 2)
  const messages = [
    user("Compare Tokyo and London."),
    { role: "assistant", content: null, toolCalls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
    { role: "tool", toolCallId: "a", content: "20" }
  ]
  await run(adapter, { tools: [weather], messages })
  assert.equal(native.named("submitToolResult").length, 0)
  const sessions = native.named("createSession")
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions[1].messages, [
    { role: "user", text: "Compare Tokyo and London." },
    { role: "assistant", text: "", toolCalls: calls },
    { role: "tool", toolCallId: "a", name: "get_weather", text: "20" }
  ])
  assert.equal(native.named("respond")[1].prompt, "")
})

test("a thread's next message prompts its kept session with only that message", async () => {
  native.replies = [[{ type: "done", text: "It's sunny." }], [{ type: "done", text: "Yes." }]]
  const adapter = afmText({ native })
  await run(adapter)
  await run(adapter, { messages: [user("Weather in Paris?"), { role: "assistant", content: "It's sunny." }, user("Warm?")] })
  assert.equal(native.named("createSession").length, 1)
  const responds = native.named("respond")
  assert.equal(responds[1].prompt, "Warm?")
  assert.equal(responds[1].sessionId, responds[0].sessionId)
  assert.equal(responds[1].turn, 2)
})

test("an edited conversation starts a new session holding the messages, and ends the old one", async () => {
  native.replies = [[{ type: "done", text: "It's sunny." }], [{ type: "done", text: "Rainy." }]]
  const adapter = afmText({ native })
  await run(adapter)
  const old = native.named("createSession")[0].sessionId
  await run(adapter, { messages: [user("Weather in Oslo?"), { role: "assistant", content: "Snowy." }, user("And Paris?")] })
  const sessions = native.named("createSession")
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions[1].messages, [{ role: "user", text: "Weather in Oslo?" }, { role: "assistant", text: "Snowy." }])
  assert.equal(native.named("respond")[1].prompt, "And Paris?")
  assert.deepEqual(native.named("deleteSession"), [{ sessionId: old }])
})

test("a native error ends with RUN_ERROR and its code, and ends the session", async () => {
  native.replies = [[{ type: "error", code: "guardrailViolation", message: "Blocked" }]]
  const chunks = await run(afmText({ native }))
  const error = chunks.at(-1)
  assert.equal(error?.type, "RUN_ERROR")
  assert.equal(error?.message, "Blocked")
  assert.deepEqual(error?.error, { message: "Blocked", code: "guardrailViolation" })
  assert.equal(native.named("deleteSession").length, 1)
})

test("an abort cancels the response and ends with RUN_ERROR (code aborted)", async () => {
  native.replies = [[]]
  const abortController = new AbortController()
  setTimeout(() => abortController.abort(), 5)
  const chunks = await run(afmText({ native }), { abortController })
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal((chunks.at(-1)?.error as Record<string, unknown>).code, "aborted")
  assert.equal(native.named("cancel").length, 1)
  assert.equal(native.named("deleteSession").length, 1)
})

test("structured output: a session answers the last message held to the schema", async () => {
  native.replies = [[{ type: "done", text: '{"city":"Tokyo"}' }]]
  const result = await afmText({ native }).structuredOutput({
    chatOptions: chatOptions(),
    outputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  } as never)
  assert.deepEqual(result.data, { city: "Tokyo" })
  const [respond] = native.named("respond")
  assert.equal(respond.prompt, "Weather in Paris?")
  assert.deepEqual((respond.schema as Record<string, unknown>).root, {
    kind: "object",
    name: "Answer",
    properties: [{ name: "city", optional: false, schema: { kind: "string" } }]
  })
  assert.equal(native.named("deleteSession").length, 1)
})

test("availability: available, downloading while the model isn't ready, else unavailable", async () => {
  const adapter = afmText({ native })
  assert.equal(await adapter.availability(), "available")
  assert.equal(await adapter.contextSize(), 4096)
  native.answer = { available: false, reason: "modelNotReady" }
  assert.equal(await adapter.availability(), "downloading")
  native.answer = { available: false, reason: "appleIntelligenceNotEnabled" }
  assert.equal(await adapter.availability(), "unavailable")
  await assert.rejects(adapter.create(), /appleIntelligenceNotEnabled/)
  native.availability = async () => {
    throw new Error("not implemented on web")
  }
  assert.equal(await adapter.availability(), "unavailable")
})

test("without a native side given, window.afm (an Electron preload's) is used", async () => {
  native.answer = { available: true, contextSize: 2048 }
  ;(globalThis as { afm?: unknown }).afm = native
  try {
    assert.equal(await afmText().contextSize(), 2048)
  } finally {
    delete (globalThis as { afm?: unknown }).afm
  }
})

const pausedCall = [{ type: "toolCalls", calls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }] }] as Array<Event>
const afterCall = (city = "Paris") => [
  user("Weather in Paris?"),
  { role: "assistant", content: "", toolCalls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city }) } }] },
  { role: "tool", toolCallId: "call_1", content: "Sunny" }
]

test("with prompt cache retention none, the step with the tool's result resumes the paused response, and the session ends after", async () => {
  const adapter = afmText({ native })
  native.replies = [pausedCall]
  native.resumes = [[{ type: "done", text: "Sunny." }]]
  const first = await run(adapter, { tools: [weather], promptCache: { retention: "none" } })
  assert.equal(first.at(-1)?.finishReason, "tool_calls")
  const second = await run(adapter, { tools: [weather], promptCache: { retention: "none" }, messages: afterCall() })
  assert.equal(textIn(second), "Sunny.")
  const [session] = native.named("createSession")
  assert.equal(native.named("createSession").length, 1)
  assert.deepEqual(native.named("submitToolResult").map((o) => o.sessionId), [session.sessionId])
  assert.ok(native.named("deleteSession").some((o) => o.sessionId === session.sessionId))
})

test("destroy() ends a paused response no thread keeps", async () => {
  const adapter = afmText({ native })
  native.replies = [pausedCall]
  await run(adapter, { tools: [weather], promptCache: { retention: "none" } })
  const [session] = native.named("createSession")
  await adapter.destroy()
  assert.ok(native.named("deleteSession").some((o) => o.sessionId === session.sessionId))
})

test("destroy() during a response ends its stream with an error", async () => {
  const adapter = afmText({ native })
  native.replies = [[]] // a response that doesn't answer on its own
  const stream = adapter.chatStream(chatOptions())[Symbol.asyncIterator]()
  await stream.next()
  const next = stream.next()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await adapter.destroy()
  const chunk = (await next).value as Chunk
  assert.equal(chunk.type, "RUN_ERROR")
  assert.equal((chunk.error as { code?: string }).code, "closed")
})

test("an edited tool call in the conversation starts a new session", async () => {
  const adapter = afmText({ native })
  native.replies = [[{ type: "done", text: "It's sunny." }]]
  await run(adapter, { tools: [weather], messages: afterCall("Paris") })
  native.replies = [[{ type: "done", text: "Yes." }]]
  await run(adapter, { tools: [weather], messages: [...afterCall("Tokyo"), { role: "assistant", content: "It's sunny." }, user("Sure?")] })
  assert.equal(native.named("createSession").length, 2)
  // The same conversation, unedited, keeps its session.
  native.replies = [[{ type: "done", text: "Yes." }]]
  await run(adapter, { tools: [weather], messages: [...afterCall("Tokyo"), { role: "assistant", content: "It's sunny." }, user("Sure?"), { role: "assistant", content: "Yes." }, user("Thanks")] })
  assert.equal(native.named("createSession").length, 2)
})

test("a session without tools gets the system prompt alone; tool choice sets the framework's tool-calling mode", async () => {
  const adapter = afmText({ native })
  await run(adapter, { systemPrompts: ["Be brief."], threadId: "no-tools" })
  assert.equal(native.named("createSession").at(-1)?.instructions, "Be brief.")
  const respondOptions = () => (native.named("respond").at(-1)?.options ?? {}) as Record<string, unknown>
  assert.equal(respondOptions().toolCallingMode, undefined)
  await run(adapter, { tools: [weather], toolChoice: "required", threadId: "required" })
  assert.equal(respondOptions().toolCallingMode, "required")
  await run(adapter, { tools: [weather], threadId: "auto" })
  assert.equal(respondOptions().toolCallingMode, undefined)
})

test("destroy() ends responses streaming in sessions no thread keeps, and structured output", async () => {
  const adapter = afmText({ native })
  native.replies = [[], []] // responses that don't answer on their own
  const stream = adapter.chatStream(chatOptions({ promptCache: { retention: "none" } }))[Symbol.asyncIterator]()
  await stream.next()
  const next = stream.next()
  const structured = adapter
    .structuredOutput({ chatOptions: chatOptions({ threadId: "structured" }), outputSchema: { type: "object", properties: { a: { type: "string" } } } } as never)
    .then(() => "resolved", (e: Error) => `rejected: ${e.message}`)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const sessions = native.named("createSession").map((o) => o.sessionId)
  assert.equal(sessions.length, 2)
  await adapter.destroy()
  assert.equal(((await next).value as Chunk).type, "RUN_ERROR")
  assert.match(await structured, /^rejected: The session was closed/)
  for (const id of sessions) assert.ok(native.named("deleteSession").some((o) => o.sessionId === id))
})

test("a step whose tool choice differs from its paused response's starts a new session instead of resuming it", async () => {
  const adapter = afmText({ native })
  native.replies = [pausedCall, [{ type: "done", text: "Sunny." }]]
  await run(adapter, { tools: [weather], toolChoice: "required" })
  await run(adapter, { tools: [weather], toolChoice: "auto", messages: afterCall() })
  assert.equal(native.named("createSession").length, 2)
  assert.equal(native.named("submitToolResult").length, 0)
  const [first, second] = native.named("respond").map((o) => (o.options as Record<string, unknown>).toolCallingMode)
  assert.equal(first, "required")
  assert.equal(second, undefined)
})

test("a request already stopped starts no native work, even when the bridge would answer at once", async () => {
  const adapter = afmText({ native })
  native.replies = [[{ type: "done", text: "Finished anyway." }]]
  const stopped = new AbortController()
  stopped.abort()
  const chunks = await run(adapter, { abortController: stopped })
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal(native.named("createSession").length, 0)
  assert.equal(native.named("respond").length, 0)
  assert.equal(textIn(chunks), "")
})
