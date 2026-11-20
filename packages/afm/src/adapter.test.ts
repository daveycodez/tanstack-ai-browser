import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat, supportedReasoningLevels } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"

import { afmText } from "./adapter.js"
import { AFM_MODEL_REASONING, SystemLanguageModel } from "./index.js"
import { answerInstruction, draftInstruction, draftPrompt, REPLY_PROMPT, thoughtsPrompt } from "./reasoning.js"
import { jsonAsk } from "./repair.js"
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
  /** How many listeners are registered now. */
  listeners = 0
  private turns = new Map<string, number>()
  private waiting = new Map<string, Set<string>>()

  async availability(options?: Record<string, unknown>) {
    this.calls.push(["availability", options ?? {}])
    return this.answer
  }
  async addListener(_name: "event", listener: (event: NativeEvent) => void) {
    this.listener = listener
    this.listeners += 1
    return {
      remove: async () => {
        this.listeners -= 1
        if (this.listener === listener) this.listener = undefined
      }
    }
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
  protected play(sessionId: string, events: Array<Event>) {
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

test("cached tokens pass through where the bridge counts them; none is left out, as TanStack reports it", async () => {
  const adapter = afmText({ native })
  for (const [cachedTokens, details] of [[2890, { cachedTokens: 2890 }], [0, undefined]] as const) {
    native.replies = [[{ type: "done", text: "Hi", usage: { inputTokens: 2907, cachedTokens, outputTokens: 2 } }]]
    const chunks = await run(adapter, { threadId: `cached-${cachedTokens}` })
    assert.deepEqual((chunks.at(-1)?.usage as Record<string, unknown>).promptTokensDetails, details)
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
  // The system prompt as given: the adapter adds nothing on when to call tools.
  assert.equal(session.instructions, "Be brief.")
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

test("token counts the native side estimated (before iOS/macOS 27) are reported as estimates", async () => {
  native.replies = [[{ type: "done", text: "Hi", usage: { inputTokens: 317, outputTokens: 16, estimated: true } }]]
  const chunks = await run(afmText({ native }), { threadId: "estimated" })
  const usage = chunks.at(-1)?.usage as Record<string, unknown>
  assert.deepEqual([usage.promptTokens, usage.completionTokens, usage.totalTokens], [317, 16, 333])
  assert.deepEqual(usage.providerUsageDetails, { estimated: true })
  // The framework's own counts carry no such mark.
  native.replies = [[{ type: "done", text: "Hi", usage: { inputTokens: 317, outputTokens: 16 } }]]
  const counted = await run(afmText({ native }), { threadId: "counted" })
  assert.equal((counted.at(-1)?.usage as Record<string, unknown>).providerUsageDetails, undefined)
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

test("a structured answer cut off by maximumResponseTokens fails with the bridge's code length", async () => {
  native.replies = [[{ type: "error", code: "length", message: "The answer passed maximumResponseTokens (4) before it was complete" }]]
  const adapter = afmText({ native })
  await assert.rejects(
    adapter.structuredOutput({ chatOptions: { model: "system", messages: [user("A card?")], logger, modelOptions: { maximumResponseTokens: 4 } }, outputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } as never),
    (error: { code?: string; message?: string }) => error.code === "length" && /maximumResponseTokens/.test(error.message ?? "")
  )
  assert.deepEqual(native.named("respond")[0].options, { maximumResponseTokens: 4 })
})

test("each step's RUN_FINISHED carries its own pass's tokens, as an OpenAI-style API reports each call's: the calls' pass, then the answer's", async () => {
  native.replies = [[{ type: "toolCalls", calls: [{ id: "call-1", name: "get_weather", arguments: '{"city": "Paris"}' }], usage: { inputTokens: 132, outputTokens: 24 } }]]
  native.resumes = [[{ type: "done", text: "Sunny in Paris.", usage: { inputTokens: 191, outputTokens: 51 } }]]
  const adapter = afmText({ native })
  const first = await run(adapter, { tools: [weather] })
  const calls = first.at(-1)?.usage as Record<string, unknown>
  assert.equal(calls.promptTokens, 132)
  assert.equal(calls.completionTokens, 24)
  const messages = [
    user("Weather in Paris?"),
    { role: "assistant", content: null, toolCalls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city": "Paris"}' } }] },
    { role: "tool", toolCallId: "call-1", content: '{"temperature": 21}' }
  ]
  const second = await run(adapter, { tools: [weather], messages })
  const answer = second.at(-1)?.usage as Record<string, unknown>
  assert.equal(answer.promptTokens, 191)
  assert.equal(answer.completionTokens, 51)
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

test("variant(): the native check's key as Apple's constants, compared with ===; an unknown 27 variant one per name; undefined when unavailable", async () => {
  const adapter = afmText({ native })
  const { Variant } = SystemLanguageModel
  for (const [key, variant, name] of [
    ["core3", Variant.core3, "AFM 3 Core"],
    ["coreAdvanced3", Variant.coreAdvanced3, "AFM 3 Core Advanced"],
    ["core2_1", Variant.core2_1, "AFM 2.1 Core"],
    ["core2", Variant.core2, "AFM 2 Core"]
  ] as const) {
    native.answer = { available: true, contextSize: 4096, variant: key }
    const got = await adapter.variant()
    assert.equal(got, variant)
    assert.equal(got?.displayName, name)
  }
  native.answer = { available: true, variantName: "AFM 4 Core" }
  const unknown = await adapter.variant()
  assert.equal(unknown?.displayName, "AFM 4 Core")
  assert.equal(await adapter.variant(), unknown, "the same instance for the same name")
  native.answer = { available: true }
  assert.equal(await adapter.variant(), undefined, "a native side too old to say")
  native.answer = { available: false, reason: "deviceNotEligible", variant: "core2" }
  assert.equal(await adapter.variant(), undefined)
  native.availability = async () => {
    throw new Error("not implemented on web")
  }
  assert.equal(await adapter.variant(), undefined)
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

test("destroy() stops listening to the native side; used again, the adapter listens again", async () => {
  const adapter = afmText({ native })
  native.replies = [[{ type: "done", text: "One." }], [{ type: "done", text: "Two." }]]
  assert.equal(textIn(await run(adapter)), "One.")
  assert.equal(native.listeners, 1)
  await adapter.destroy()
  assert.equal(native.listeners, 0)
  assert.equal(textIn(await run(adapter)), "Two.")
  assert.equal(native.listeners, 1)
  // Destroyed before it ever listened, or twice: nothing to remove.
  await adapter.destroy()
  await adapter.destroy()
  assert.equal(native.listeners, 0)
  await afmText({ native }).destroy()
  assert.equal(native.listeners, 0)
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

test("guardrails reach the native side: the adapter's for every session and the availability check, a request's over it", async () => {
  const adapter = afmText({ native, guardrails: "permissiveContentTransformations" })
  assert.equal(await adapter.availability(), "available")
  assert.deepEqual(native.named("availability").at(-1), { guardrails: "permissiveContentTransformations" })
  await run(adapter, { threadId: "permissive" })
  assert.equal(native.named("createSession").at(-1)?.guardrails, "permissiveContentTransformations")
  await run(adapter, { threadId: "own", modelOptions: { guardrails: "default" } })
  assert.equal(native.named("createSession").at(-1)?.guardrails, "default")
  // None named: none sent, so the host's (serveAfm's) or Apple's default applies.
  await run(afmText({ native }), { threadId: "none" })
  assert.equal("guardrails" in (native.named("createSession").at(-1) ?? {}), false)
})

test("a thread whose guardrails change starts a new session: a session's guardrails are its model's", async () => {
  const adapter = afmText({ native })
  native.replies = [[{ type: "done", text: "Hi." }], [{ type: "done", text: "Hi again." }]]
  await run(adapter, { messages: [user("Hi")] })
  await run(adapter, { messages: [user("Hi"), { role: "assistant", content: "Hi." }, user("Again")], modelOptions: { guardrails: "permissiveContentTransformations" } })
  assert.equal(native.named("createSession").length, 2)
})

test("a thread moving between inherited guardrails and an explicit default starts a new session, both ways", async () => {
  for (const [first, second] of [[undefined, "default"], ["default", undefined]] as const) {
    native = new FakeNative()
    const adapter = afmText({ native })
    native.replies = [[{ type: "done", text: "Hi." }], [{ type: "done", text: "Hi again." }]]
    await run(adapter, { messages: [user("Hi")], ...(first && { modelOptions: { guardrails: first } }) })
    await run(adapter, { messages: [user("Hi"), { role: "assistant", content: "Hi." }, user("Again")], ...(second && { modelOptions: { guardrails: second } }) })
    assert.equal(native.named("createSession").length, 2, `${first ?? "inherited"} then ${second ?? "inherited"}`)
  }
})

test("a run's error keeps its code through chat(): on the thrown error, and on the stream's RUN_ERROR", async () => {
  native.replies = [[{ type: "error", code: "guardrailViolation", message: "May contain unsafe content" }]]
  const thrown = (await (chat({ adapter: afmText({ native }), stream: false, threadId: "errors", messages: [user("Searing Blood")] } as never) as unknown as Promise<unknown>).catch((e: unknown) => e)) as Error & { code?: string }
  assert.equal(thrown.message, "May contain unsafe content")
  assert.equal(thrown.code, "guardrailViolation")
  native.replies = [[{ type: "error", code: "guardrailViolation", message: "May contain unsafe content" }]]
  const chunks = await run(afmText({ native }), { threadId: "errors-stream" })
  const error = chunks.find((c) => c.type === "RUN_ERROR")
  assert.equal(error?.code, "guardrailViolation")
  assert.deepEqual(error?.error, { message: "May contain unsafe content", code: "guardrailViolation" })
})

test("structured output keeps the error's code through chat(): on the thrown error, and on the stream's RUN_ERROR", async () => {
  const outputSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  const blocked = [{ type: "error", code: "guardrailViolation", message: "May contain unsafe content" }] as Array<Event>
  native.replies = [blocked]
  const thrown = (await (chat({ adapter: afmText({ native }), threadId: "structured-errors", messages: [user("Searing Blood")], outputSchema, stream: false } as never) as unknown as Promise<unknown>).catch((e: unknown) => e)) as Error & { code?: string }
  assert.equal(thrown.message, "May contain unsafe content")
  assert.equal(thrown.code, "guardrailViolation")
  native.replies = [blocked]
  const chunks: Array<Chunk> = []
  for await (const chunk of chat({ adapter: afmText({ native }), threadId: "structured-errors-stream", messages: [user("Searing Blood")], outputSchema, stream: true } as never) as unknown as AsyncIterable<Chunk>) chunks.push(chunk)
  assert.equal(chunks.find((c) => c.type === "RUN_ERROR")?.code, "guardrailViolation")
  // An answer that isn't JSON still has TanStack's parse-failure code.
  native.replies = [[{ type: "done", text: "not json" }]]
  const parse = (await (chat({ adapter: afmText({ native }), threadId: "structured-parse", messages: [user("Paris")], outputSchema, stream: false } as never) as unknown as Promise<unknown>).catch((e: unknown) => e)) as Error & { code?: string }
  assert.equal(parse.code, "structured-output-parse-failed")
})

test("sampling reaches the native response: none by default, the adapter's for every response, a request's over it, structured output too", async () => {
  const respondOptions = () => (native.named("respond").at(-1)?.options ?? {}) as Record<string, unknown>
  await run(afmText({ native }), { threadId: "default" })
  assert.equal("sampling" in respondOptions(), false)
  const greedy = afmText({ native, sampling: "greedy" })
  await run(greedy, { threadId: "greedy" })
  assert.equal(respondOptions().sampling, "greedy")
  await run(greedy, { threadId: "top-k", modelOptions: { sampling: { topK: 40, seed: 7 } } })
  assert.deepEqual(respondOptions().sampling, { topK: 40, seed: 7 })
  native.replies = [[{ type: "done", text: '{"city":"Paris"}' }]]
  await greedy.structuredOutput({ chatOptions: chatOptions({ threadId: "structured" }), outputSchema: { type: "object", properties: { city: { type: "string" } } } } as never)
  assert.equal(respondOptions().sampling, "greedy")
})

test("includeSchemaInPrompt false reaches the native response: the adapter's for every call, a request's over it; true by default", async () => {
  const outputSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  const ask = async (config: Record<string, unknown>, modelOptions?: Record<string, unknown>) => {
    native = new FakeNative()
    native.replies = [[{ type: "done", text: '{"city":"Paris"}' }]]
    await afmText({ native, ...config }).structuredOutput({ chatOptions: chatOptions(modelOptions ? { modelOptions } : {}), outputSchema } as never)
    return (native.named("respond")[0].options as Record<string, unknown>).includeSchemaInPrompt
  }
  assert.equal(await ask({}), undefined, "Apple's default: the schema in the prompt")
  assert.equal(await ask({ includeSchemaInPrompt: false }), false)
  assert.equal(await ask({ includeSchemaInPrompt: false }, { includeSchemaInPrompt: true }), undefined)
  assert.equal(await ask({}, { includeSchemaInPrompt: false }), false)
})

const high = { reasoning: { level: "high", summary: true } }
const reasoningIn = (chunks: Array<Chunk>) =>
  chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta).join("")
/** A draft's response, and a reply's, as the native side sends them. */
const NOTES: Array<Event> = [{ type: "delta", text: "Needs " }, { type: "delta", text: "the weather." }, { type: "done", text: "Needs the weather.", usage: { inputTokens: 100, outputTokens: 5 } }]
const REPLY: Array<Event> = [{ type: "delta", text: "Hello " }, { type: "done", text: "Hello there", usage: { inputTokens: 110, outputTokens: 3 } }]
const asked = [user("Weather in Paris?")]
/** The notes' prompt for a user's message: the instruction, then the message under it. */
const drafting = (message: string, messages: Array<unknown>, edits = false) => draftPrompt(message, draftInstruction(messages as never, edits))
type Respond = { sessionId: string; turn: number; prompt: string; options: Record<string, unknown> }

test("the draft's instruction repeats nothing of the conversation, and asks about a tool's results after them; its prompt pairs it with the message", () => {
  // Where a session's transcript can be changed (iOS/macOS 27): AFM 3 Core's words.
  assert.equal(draftInstruction(asked as never, true), "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether it needs something you can't know or do yourself, like anything current or recent, that one of your tools gets, and which. Don't call tools or write the reply yet.")
  assert.equal(draftInstruction([...asked, { role: "assistant", content: "" }, { role: "tool", toolCallId: "c1", content: "20C" }] as never, true), "Now write notes for yourself, not to the user, before replying to the user's latest message: what the tool results above tell you, and whether to answer with them or which different call would add what's missing. Don't call tools or write the reply yet.")
  // Where it can't (before 27): AFM 2 Core's.
  assert.equal(draftInstruction(asked as never, false), "Before replying to the user's message below, think it through in a sentence or two: what do they want, and will you answer directly or call a tool? Write only that. Don't call tools or write the reply yet.")
  assert.equal(draftInstruction([...asked, { role: "assistant", content: "" }, { role: "tool", toolCallId: "c1", content: "20C" }] as never, false), "Before replying, think it through in a sentence or two: what do the tool results above tell you, and will you answer now or call another tool? Write only that. Don't call tools or write the reply yet.")
  assert.equal(REPLY_PROMPT, "Now reply.")
  // The instruction, a blank line, the user's message under it. Without a message, the instruction alone.
  assert.equal(draftPrompt("Hi", "Think."), "Instructions:\nThink.\n\nMessage:\nHi")
  assert.equal(draftPrompt(undefined, "Think."), "Instructions:\nThink.")
  assert.deepEqual(supportedReasoningLevels(AFM_MODEL_REASONING.system), ["off", "high"])
})

test("reasoning high: the thread's session drafts working notes with tool calling off, then replies after them, and is kept", async () => {
  native.replies = [NOTES, REPLY]
  const chunks = await run(afmText({ native }), { ...high, systemPrompts: ["Be brief."], tools: [weather], modelOptions: { temperature: 0.2 } })
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
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ])
  assert.equal(reasoningIn(chunks), "Needs the weather.")
  assert.equal(textIn(chunks), "Hello there")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
  const reasoningIds = new Set(chunks.filter((c) => c.type.startsWith("REASONING")).map((c) => c.messageId))
  assert.ok(!reasoningIds.has(chunks.find((c) => c.type === "TEXT_MESSAGE_START")?.messageId), "not the reply's message")

  const sessions = native.named("createSession")
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].instructions, "Be brief.", "the system prompt as given")
  assert.equal((sessions[0].tools as Array<{ name: string }>)[0].name, "get_weather")
  assert.deepEqual(sessions[0].messages, [], "the user's message is in the draft's prompt")
  const [draft, reply] = native.named("respond") as Array<Respond>
  assert.equal(native.named("respond").length, 2)
  assert.deepEqual([draft.sessionId, reply.sessionId], [sessions[0].sessionId, sessions[0].sessionId], "both the thread's session's")
  assert.deepEqual([draft.turn, reply.turn], [1, 2])
  assert.equal(draft.prompt, drafting("Weather in Paris?", asked))
  assert.deepEqual(draft.options, { temperature: 0.2, toolCallingMode: "disallowed" })
  assert.equal(reply.prompt, REPLY_PROMPT)
  assert.deepEqual(reply.options, { temperature: 0.2 })
  // The step's tokens are both responses', the notes' as reasoning tokens.
  const usage = chunks.at(-1)?.usage as Record<string, unknown>
  assert.equal(usage.promptTokens, 210)
  assert.equal(usage.completionTokens, 8)
  assert.deepEqual(usage.completionTokensDetails, { reasoningTokens: 5 })
  assert.equal(native.named("deleteSession").length, 0, "kept for the thread")
})

test("the thread's next message goes on in the same session, with or without reasoning", async () => {
  native.replies = [NOTES, REPLY, [{ type: "done", text: "Tomorrow now." }], [{ type: "done", text: "Rain." }], [{ type: "done", text: "Bye." }]]
  const adapter = afmText({ native })
  await run(adapter, high)
  const second = [...asked, { role: "assistant", content: "Hello there" }, user("And tomorrow?")]
  const chunks = await run(adapter, { ...high, messages: second })
  assert.equal(reasoningIn(chunks), "Tomorrow now.")
  assert.equal(textIn(chunks), "Rain.")
  await run(adapter, { messages: [...second, { role: "assistant", content: "Rain." }, user("Thanks")] })
  assert.equal(native.named("createSession").length, 1, "one session for the thread")
  assert.equal(native.named("deleteSession").length, 0)
  const responds = native.named("respond") as Array<Respond>
  assert.deepEqual(responds.map((r) => r.turn), [1, 2, 3, 4, 5])
  assert.equal(responds[2].prompt, drafting("And tomorrow?", second), "only the new message")
  assert.equal(responds[3].prompt, REPLY_PROMPT)
  assert.equal(responds[4].prompt, "Thanks", "without reasoning, the message as it is")
})

test("reasoning off, or none: the thread's session answers the message, as without it", async () => {
  for (const extra of [{}, { reasoning: { level: "off", summary: true } }]) {
    native = new FakeNative()
    native.replies = [REPLY]
    const chunks = await run(afmText({ native }), extra)
    assert.ok(!chunks.some((c) => c.type.startsWith("REASONING")))
    assert.deepEqual(native.named("respond").map((r) => r.prompt), ["Weather in Paris?"])
    assert.equal(native.named("deleteSession").length, 0, "kept for the thread")
  }
})

test("a thinking step's tool call waits like any other: the step with its result resumes the response, without notes", async () => {
  const call = { id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' }
  native.replies = [NOTES, [{ type: "toolCalls", calls: [call], usage: { inputTokens: 110, outputTokens: 9 } }]]
  native.resumes = [[{ type: "delta", text: "Sunny, 20 degrees." }, { type: "done", text: "Sunny, 20 degrees." }]]
  const adapter = afmText({ native })
  const called = await run(adapter, { ...high, tools: [weather] })
  assert.equal(reasoningIn(called), "Needs the weather.")
  assert.equal(called.at(-1)?.finishReason, "tool_calls")
  assert.deepEqual(called.find((c) => c.type === "TOOL_CALL_END")?.input, { city: "Paris" })
  // The draft's tokens are in the step that made the call.
  assert.deepEqual((called.at(-1)?.usage as Record<string, unknown>).completionTokensDetails, { reasoningTokens: 5 })
  assert.equal((called.at(-1)?.usage as Record<string, unknown>).completionTokens, 14)

  const messages = [
    ...asked,
    { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", toolCallId: "c1", content: "20C" }
  ]
  const answered = await run(adapter, { ...high, tools: [weather], messages })
  assert.ok(!answered.some((c) => c.type.startsWith("REASONING")), "the framework goes on with the response")
  assert.equal(textIn(answered), "Sunny, 20 degrees.")
  assert.deepEqual(native.named("submitToolResult"), [{ sessionId: native.named("createSession")[0].sessionId, callId: "c1", output: "20C" }])
  assert.equal(native.named("createSession").length, 1)
  assert.equal(native.named("respond").length, 2, "the draft and the reply, no more")
  assert.equal(native.named("deleteSession").length, 0)
})

test("a conversation that ends in a tool's result, in a new session: the instruction alone asks for notes about the result", async () => {
  native.replies = [[{ type: "done", text: "It is 20 degrees." }], [{ type: "done", text: "Sunny, 20 degrees." }]]
  const messages = [
    ...asked,
    { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", toolCallId: "c1", content: "20C" }
  ]
  const chunks = await run(afmText({ native }), { ...high, tools: [weather], messages })
  assert.equal(reasoningIn(chunks), "It is 20 degrees.")
  assert.equal(textIn(chunks), "Sunny, 20 degrees.")
  const [session] = native.named("createSession")
  assert.deepEqual((session.messages as Array<{ role: string }>).map((m) => m.role), ["user", "assistant", "tool"])
  const responds = native.named("respond") as Array<Respond>
  assert.equal(responds[0].prompt, draftPrompt(undefined, draftInstruction(messages as never, false)), "there's no message to pair it with")
  assert.match(responds[0].prompt, /what do the tool results above tell you, and will you answer now/)
  assert.equal(responds[1].prompt, REPLY_PROMPT)
})

test("a tool call the draft makes all the same is the step's: no reply is asked for, and its result resumes it", async () => {
  native.replies = [[{ type: "delta", text: "Checking. " }, { type: "toolCalls", calls: [{ id: "d1", name: "get_weather", arguments: '{"city":"Paris"}' }], usage: { inputTokens: 100, outputTokens: 12 } }]]
  native.resumes = [[{ type: "done", text: "Sunny." }]]
  const adapter = afmText({ native })
  const chunks = await run(adapter, { ...high, tools: [weather] })
  assert.equal(reasoningIn(chunks), "Checking. ")
  const types = typesOf(chunks)
  assert.deepEqual(types.slice(types.indexOf("REASONING_END") + 1), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
  assert.equal(chunks.find((c) => c.type === "TOOL_CALL_END")?.toolCallId, "d1")
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  assert.equal((chunks.at(-1)?.usage as Record<string, unknown>).completionTokens, 12)
  assert.equal(native.named("respond").length, 1)

  const answered = await run(adapter, {
    ...high,
    tools: [weather],
    messages: [
      ...asked,
      { role: "assistant", content: "", toolCalls: [{ id: "d1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", toolCallId: "d1", content: "20C" }
    ]
  })
  assert.equal(textIn(answered), "Sunny.")
  assert.equal(native.named("submitToolResult").length, 1)
  assert.equal(native.named("respond").length, 1)
})

test("budgetTokens caps the notes; maximumResponseTokens covers the notes and the reply together", async () => {
  native.replies = [NOTES, REPLY]
  await run(afmText({ native }), { reasoning: { level: "high", summary: true, budgetTokens: 64 } })
  let responds = native.named("respond") as Array<Respond>
  assert.equal(responds[0].options.maximumResponseTokens, 64, "the draft's")
  assert.equal("maximumResponseTokens" in responds[1].options, false, "the reply has no cap of its own")

  native = new FakeNative()
  native.replies = [NOTES, REPLY]
  await run(afmText({ native }), { reasoning: { level: "high", summary: true, budgetTokens: 64 }, modelOptions: { maximumResponseTokens: 20 } })
  responds = native.named("respond") as Array<Respond>
  assert.equal(responds[0].options.maximumResponseTokens, 20, "the smaller of the two")
  assert.equal(responds[1].options.maximumResponseTokens, 15, "what the notes left")

  // Notes that used the cap up leave no reply.
  native = new FakeNative()
  native.replies = [[{ type: "done", text: "Needs the", usage: { inputTokens: 100, outputTokens: 5 } }]]
  const cut = await run(afmText({ native }), { ...high, modelOptions: { maximumResponseTokens: 5 } })
  assert.equal(reasoningIn(cut), "Needs the")
  assert.equal(textIn(cut), "")
  assert.equal(cut.at(-1)?.finishReason, "length")
  assert.equal(native.named("respond").length, 1)

  // A budget of none is no notes: the step is as without reasoning.
  native = new FakeNative()
  native.replies = [REPLY]
  const none = await run(afmText({ native }), { reasoning: { level: "high", summary: true, budgetTokens: 0 } })
  assert.ok(!none.some((c) => c.type.startsWith("REASONING")))
  assert.deepEqual(native.named("respond").map((r) => r.prompt), ["Weather in Paris?"])
})

test("an abort mid-draft ends the reasoning, then RUN_ERROR (code aborted), and ends the session", async () => {
  const controller = new AbortController()
  native.replies = [[{ type: "delta", text: "Needs " }]]
  const chunks: Array<Chunk> = []
  for await (const chunk of afmText({ native }).chatStream(chatOptions({ ...high, abortController: controller }))) {
    chunks.push(chunk as Chunk)
    if (chunk.type === "REASONING_MESSAGE_CONTENT") controller.abort(new Error("stop"))
  }
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "REASONING_END", "RUN_ERROR"])
  assert.equal(chunks.at(-1)?.code, "aborted")
  const [session] = native.named("createSession")
  assert.deepEqual(native.named("cancel"), [{ sessionId: session.sessionId }])
  assert.deepEqual(native.named("deleteSession"), [{ sessionId: session.sessionId }])
  assert.equal(native.named("respond").length, 1, "no reply was asked for")
})

test("chat() takes reasoning for the model and streams its notes", async () => {
  native.replies = [NOTES, REPLY]
  const chunks: Array<Chunk> = []
  for await (const chunk of chat({
    adapter: afmText({ native }),
    threadId: "chat-reasoning",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    reasoning: { level: "high", budgetTokens: 64 },
    stream: true
  })) chunks.push(chunk as Chunk)
  assert.equal(reasoningIn(chunks), "Needs the weather.")
  assert.equal(textIn(chunks), "Hello there")
})

/** A native side that changes a session's own conversation, as iOS/macOS 27's does: the notes come out before the reply. */
class EditingNative extends FakeNative {
  override answer: NativeAvailability = { available: true, contextSize: 4096, editsTranscript: true, stopsAtToolCalls: true }
  async trimTranscript(options: Record<string, unknown>) {
    this.calls.push(["trimTranscript", options])
  }
  async rewriteTurn(options: Record<string, unknown>) {
    this.calls.push(["rewriteTurn", options])
  }
  async finishToolCalls(options: { sessionId: string } & Record<string, unknown>) {
    this.calls.push(["finishToolCalls", options])
    this.play(options.sessionId, [{ type: "stopped" }])
  }
}
/** The same calls where a session's own conversation can't be changed (before iOS/macOS 27): another session takes its place. */
class RebuildingNative extends EditingNative {
  override answer: NativeAvailability = { available: true, contextSize: 4096, stopsAtToolCalls: true }
}
const WEATHER_CALL = { id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' }
const withResult = [
  ...asked,
  { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
  { role: "tool", toolCallId: "c1", content: '{"temperature":"20C"}' }
]
const AFTER_TOOL =
  "Now write notes for yourself, not to the user, before replying to the user's latest message: what the tool results above tell you, and whether to answer with them or which different call would add what's missing. Don't call tools or write the reply yet."
/** The same ask where the notes stay in the session (before iOS/macOS 27). */
const KEPT_AFTER_TOOL =
  "Before replying, think it through in a sentence or two: what do the tool results above tell you, and will you answer now or call another tool? Write only that. Don't call tools or write the reply yet."
/** A native side's calls that shape a session's conversation, with what tells them apart. */
const shaping = (side: FakeNative) =>
  side.calls
    .filter(([name]) => ["respond", "trimTranscript", "finishToolCalls", "submitToolResult", "rewriteTurn"].includes(name))
    .map(([name, options]) => [
      name,
      name === "rewriteTurn"
        ? options.prompts
        : name === "finishToolCalls"
          ? (options.results as Array<{ output: string }>)[0]?.output
          : (options.prompt ?? options.entries ?? options.output)
    ])

test("where a session's own conversation can be changed (iOS/macOS 27), the draft is taken back out and the reply is to the message with its notes", async () => {
  const editing = new EditingNative()
  editing.replies = [NOTES, REPLY, [{ type: "done", text: "Tomorrow now." }], [{ type: "done", text: "Rain." }]]
  const adapter = afmText({ native: editing })
  const chunks = await run(adapter, high)
  assert.equal(reasoningIn(chunks), "Needs the weather.")
  assert.equal(textIn(chunks), "Hello there")
  const [session] = editing.named("createSession")
  // The draft, then its two entries (the prompt and the notes) out, then the reply.
  assert.deepEqual(
    editing.calls.filter(([name]) => name === "respond" || name === "trimTranscript").map(([name, options]) => [name, options.prompt ?? options.entries]),
    [
      ["respond", drafting("Weather in Paris?", asked, true)],
      ["trimTranscript", 2],
      ["respond", "Message:\nWeather in Paris?\n\nNotes:\nNeeds the weather."]
    ]
  )
  assert.deepEqual(editing.named("trimTranscript"), [{ sessionId: session.sessionId, entries: 2 }])
  // Once the reply is done, the turn's one prompt is the message as the user sent it: the notes aren't in the conversation.
  assert.deepEqual(editing.calls.at(-1), ["rewriteTurn", { sessionId: session.sessionId, prompts: 1, prompt: "Weather in Paris?" }])
  assert.equal(editing.named("deleteSession").length, 0, "the thread's own session, kept")

  // The next message, in the same session: its draft out again, and the native side asked what it can do only once.
  const second = [...asked, { role: "assistant", content: "Hello there" }, user("And tomorrow?")]
  await run(adapter, { ...high, messages: second })
  assert.equal(editing.named("createSession").length, 1)
  assert.equal(editing.named("trimTranscript").length, 2)
  assert.equal((editing.named("respond") as Array<Respond>)[3].prompt, "Message:\nAnd tomorrow?\n\nNotes:\nTomorrow now.")
  assert.deepEqual(editing.named("rewriteTurn").map((r) => [r.prompts, r.prompt]), [[1, "Weather in Paris?"], [1, "And tomorrow?"]])
  assert.equal(editing.named("availability").length, 1)
})

test("a tool's results get notes of their own (iOS/macOS 27): the response is ended at its calls, the results put in after them, and the session prompted again", async () => {
  const editing = new EditingNative()
  editing.replies = [NOTES, [{ type: "toolCalls", calls: [WEATHER_CALL], usage: { inputTokens: 110, outputTokens: 9 } }], [{ type: "done", text: "It is 20 degrees." }], [{ type: "done", text: "Sunny, 20 degrees." }]]
  const adapter = afmText({ native: editing })
  const called = await run(adapter, { ...high, tools: [weather] })
  assert.equal(called.at(-1)?.finishReason, "tool_calls")
  assert.equal(editing.named("rewriteTurn").length, 0, "the turn isn't over: its notes stay")

  const answered = await run(adapter, { ...high, tools: [weather], messages: withResult })
  assert.equal(reasoningIn(answered), "It is 20 degrees.", "notes about the result")
  assert.equal(textIn(answered), "Sunny, 20 degrees.")
  assert.equal(editing.named("submitToolResult").length, 0, "the results don't go back into the response")
  assert.deepEqual(shaping(editing), [
    ["respond", drafting("Weather in Paris?", asked, true)],
    ["trimTranscript", 2],
    ["respond", "Message:\nWeather in Paris?\n\nNotes:\nNeeds the weather."],
    ["finishToolCalls", '{"temperature":"20C"}'],
    // The results are in the conversation: the instruction alone asks about them.
    ["respond", `Instructions:\n${AFTER_TOOL}`],
    ["trimTranscript", 2],
    ["respond", "Notes:\nIt is 20 degrees."],
    // The message's prompt and the one with the notes about the result: the turn's two.
    ["rewriteTurn", 2]
  ])
  const responds = editing.named("respond") as Array<Respond>
  assert.equal(responds[2].options.toolCallingMode, "disallowed", "notes call no tool")
  assert.deepEqual(editing.named("finishToolCalls"), [{ sessionId: editing.named("createSession")[0].sessionId, results: [{ callId: "c1", output: '{"temperature":"20C"}' }] }], "nothing to leave out: the notes came out already")
  assert.deepEqual(editing.named("rewriteTurn"), [{ sessionId: editing.named("createSession")[0].sessionId, prompts: 2, prompt: "Weather in Paris?" }])
  assert.equal(editing.named("createSession").length, 1)
})

test("before iOS/macOS 27 the notes stay in the session for the reply, and all of the turn's thinking comes out once it's done", async () => {
  const old = new RebuildingNative()
  old.replies = [NOTES, REPLY]
  const adapter = afmText({ native: old })
  const chunks = await run(adapter, high)
  assert.equal(reasoningIn(chunks), "Needs the weather.")
  assert.equal(textIn(chunks), "Hello there")
  const [session] = old.named("createSession")
  // The notes' prompt, its notes left where they are, and the ask for the reply: the turn's two prompts become the message.
  assert.deepEqual(shaping(old), [
    ["respond", drafting("Weather in Paris?", asked)],
    ["respond", REPLY_PROMPT],
    ["rewriteTurn", 2]
  ])
  assert.equal(old.named("trimTranscript").length, 0, "nothing comes out between the notes and the reply")
  assert.deepEqual(old.named("rewriteTurn"), [{ sessionId: session.sessionId, prompts: 2, prompt: "Weather in Paris?" }])
})

test("before iOS/macOS 27 a tool's results get notes too, and the session made for them is without the turn's asks so far", async () => {
  const old = new RebuildingNative()
  old.replies = [NOTES, [{ type: "toolCalls", calls: [WEATHER_CALL] }], [{ type: "done", text: "It is 20 degrees." }], [{ type: "done", text: "Sunny, 20 degrees." }]]
  const adapter = afmText({ native: old })
  await run(adapter, { ...high, tools: [weather] })
  const answered = await run(adapter, { ...high, tools: [weather], messages: withResult })
  assert.equal(reasoningIn(answered), "It is 20 degrees.", "notes about the result")
  assert.equal(textIn(answered), "Sunny, 20 degrees.")
  assert.deepEqual(shaping(old), [
    ["respond", drafting("Weather in Paris?", asked)],
    ["respond", REPLY_PROMPT],
    ["finishToolCalls", '{"temperature":"20C"}'],
    // The results are in the conversation: the instruction alone asks about them, and the notes stay for the reply.
    ["respond", `Instructions:\n${KEPT_AFTER_TOOL}`],
    ["respond", REPLY_PROMPT],
    // The message (all that's left of the prompts before the results), the ask for notes about them and the ask for the reply.
    ["rewriteTurn", 3]
  ])
  // The session made for the results leaves out the turn's two prompts so far, and has the message where they began.
  assert.deepEqual(old.named("finishToolCalls"), [
    { sessionId: old.named("createSession")[0].sessionId, results: [{ callId: "c1", output: '{"temperature":"20C"}' }], prompts: 2, prompt: "Weather in Paris?" }
  ])
  assert.equal(old.named("trimTranscript").length, 0)
  assert.equal(old.named("createSession").length, 1)
})

test("before iOS/macOS 27 a draft that called the tool itself (the framework can't be told not to): the results get their notes all the same", async () => {
  const old = new RebuildingNative()
  old.replies = [[{ type: "toolCalls", calls: [WEATHER_CALL] }], [{ type: "done", text: "It is 20 degrees." }], [{ type: "done", text: "Sunny." }]]
  const adapter = afmText({ native: old })
  await run(adapter, { ...high, tools: [weather] })
  const answered = await run(adapter, { ...high, tools: [weather], messages: withResult })
  assert.equal(reasoningIn(answered), "It is 20 degrees.")
  assert.equal(textIn(answered), "Sunny.")
  assert.deepEqual(shaping(old), [
    ["respond", drafting("Weather in Paris?", asked)],
    ["finishToolCalls", '{"temperature":"20C"}'],
    ["respond", `Instructions:\n${KEPT_AFTER_TOOL}`],
    ["respond", REPLY_PROMPT],
    ["rewriteTurn", 3]
  ])
  assert.deepEqual(old.named("finishToolCalls").map((f) => [f.prompts, f.prompt]), [[1, "Weather in Paris?"]])
})

test("a conversation that ends in a tool's result, in a new session: the notes' prompt comes out whole, there's no message to leave", async () => {
  const editing = new EditingNative()
  editing.replies = [[{ type: "done", text: "It is 20 degrees." }], [{ type: "done", text: "Sunny, 20 degrees." }]]
  await run(afmText({ native: editing }), { ...high, tools: [weather], messages: withResult })
  const [session] = editing.named("createSession")
  assert.equal(editing.named("finishToolCalls").length, 0, "no response waited for the results")
  assert.deepEqual(editing.named("rewriteTurn"), [{ sessionId: session.sessionId, prompts: 1 }])
})

test("a native side that fails to take the notes out doesn't fail the reply", async () => {
  const failing = new EditingNative()
  failing.rewriteTurn = async () => {
    throw new Error("not implemented")
  }
  failing.replies = [NOTES, REPLY]
  const chunks = await run(afmText({ native: failing }), high)
  assert.equal(textIn(chunks), "Hello there")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
})

test("the reply's prompt after the draft is out: the message with its notes, the notes alone, or the message as it is", () => {
  assert.equal(thoughtsPrompt("Hi", "Greet them."), "Message:\nHi\n\nNotes:\nGreet them.")
  assert.equal(thoughtsPrompt(undefined, "It is 20 degrees."), "Notes:\nIt is 20 degrees.")
  assert.equal(thoughtsPrompt("Hi", ""), "Hi", "no notes: the message, as without reasoning")
})

test("a native side without the calls (another host's) keeps the draft in the session for the reply", async () => {
  // No such calls at all: the availability check isn't even made, and the notes stay in the conversation.
  native.replies = [NOTES, REPLY]
  await run(afmText({ native }), high)
  assert.equal((native.named("respond") as Array<Respond>)[1].prompt, REPLY_PROMPT)
  assert.equal(native.named("availability").length, 0, "nothing to ask it")
})

const CITY = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
const ANSWER: Array<Event> = [{ type: "done", text: '{"city":"Paris"}', usage: { inputTokens: 120, outputTokens: 4 } }]
async function structured(adapter: ReturnType<typeof afmText>, extra: Record<string, unknown> = {}) {
  const chunks: Array<Chunk> = []
  for await (const chunk of adapter.structuredOutputStream({ chatOptions: chatOptions(extra), outputSchema: CITY } as never)) chunks.push(chunk as Chunk)
  return chunks
}
const answerIn = (chunks: Array<Chunk>) => (chunks.find((c) => c.type === "CUSTOM")?.value as { object?: unknown } | undefined)?.object

test("a structured answer thinks first with reasoning: the notes as reasoning, then the answer held to the schema with the notes in hand", async () => {
  // Where a session's conversation can be changed, the notes and their prompt come out, and the answer is to the message with the notes.
  const editing = new EditingNative()
  editing.replies = [NOTES, ANSWER]
  const chunks = await structured(afmText({ native: editing }), high)
  assert.equal(reasoningIn(chunks), "Needs the weather.")
  assert.deepEqual(answerIn(chunks), { city: "Paris" })
  assert.ok(typesOf(chunks).indexOf("REASONING_END") < typesOf(chunks).indexOf("TEXT_MESSAGE_START"), "the notes end before the answer")
  const [draft, answer] = editing.named("respond") as Array<Respond & { schema?: unknown }>
  assert.equal(
    answerInstruction(true),
    "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and how you'll work out the answer. Don't write the reply yet."
  )
  // Before iOS/macOS 27 the ask is for the thinking itself, and says nothing of notes.
  assert.equal(
    answerInstruction(false),
    "Before replying to the user's message below, reason through the answer itself, step by step, in a few sentences, and end with the answer you'll give and why. Write only that. Don't write the reply yet."
  )
  assert.equal(draft.prompt, draftPrompt("Weather in Paris?", answerInstruction(true)))
  assert.equal(draft.schema, undefined, "the notes are plain text")
  assert.deepEqual(editing.named("trimTranscript").map((call) => call.entries), [2])
  assert.equal(answer.prompt, thoughtsPrompt("Weather in Paris?", "Needs the weather."))
  assert.ok(answer.schema, "the answer is held to the schema")
  // The notes' tokens are the answer's reasoning tokens.
  const finished = chunks.find((c) => c.type === "RUN_FINISHED") as { usage?: { completionTokensDetails?: { reasoningTokens?: number } } }
  assert.equal(finished.usage?.completionTokensDetails?.reasoningTokens, 5)

  // Where it can't (before iOS/macOS 27), the notes stay, and the answer is asked for after them.
  const old = new RebuildingNative()
  old.replies = [NOTES, ANSWER]
  const kept = await structured(afmText({ native: old }), high)
  assert.equal(reasoningIn(kept), "Needs the weather.")
  assert.deepEqual(answerIn(kept), { city: "Paris" })
  const asks = old.named("respond") as Array<Respond & { schema?: unknown }>
  assert.deepEqual(asks.map((ask) => ask.prompt), [draftPrompt("Weather in Paris?", answerInstruction(false)), REPLY_PROMPT])
  assert.ok(asks[1].schema)
  assert.equal(old.named("trimTranscript").length, 0)
})

test("a structured answer without reasoning is one response, as before; structuredOutput() thinks too, without the events", async () => {
  const editing = new EditingNative()
  editing.replies = [ANSWER]
  const chunks = await structured(afmText({ native: editing }))
  assert.equal(reasoningIn(chunks), "")
  assert.deepEqual(answerIn(chunks), { city: "Paris" })
  assert.deepEqual((editing.named("respond") as Array<Respond>).map((ask) => ask.prompt), ["Weather in Paris?"])

  const thinking = new EditingNative()
  thinking.replies = [NOTES, ANSWER]
  const result = await afmText({ native: thinking }).structuredOutput({ chatOptions: chatOptions(high), outputSchema: CITY } as never)
  assert.deepEqual(result.data, { city: "Paris" })
  assert.equal(thinking.named("respond").length, 2)
})

test("a structured answer's notes that fail end the reasoning and fail the answer with the error's code", async () => {
  const editing = new EditingNative()
  editing.replies = [[{ type: "delta", text: "Needs " }, { type: "error", code: "guardrailViolation", message: "May contain unsafe content" }]]
  const chunks = await structured(afmText({ native: editing }), high)
  assert.equal(reasoningIn(chunks), "Needs ")
  assert.ok(typesOf(chunks).includes("REASONING_END"))
  const failed = chunks.find((c) => c.type === "RUN_ERROR") as { code?: string; message?: string }
  assert.equal(failed.code, "guardrailViolation")
  assert.equal(editing.named("respond").length, 1, "no answer is asked for")
})

const REFUSED: Array<Event> = [{ type: "error", code: "guardrailViolation", message: "Response may contain sensitive or unsafe content" }]
const PERMISSIVE = { guardrails: "permissiveContentTransformations" } as const

test("a structured answer the guardrails refuse is asked for again as text, under the permissive guardrails, and checked against the schema", async () => {
  const editing = new EditingNative()
  editing.replies = [REFUSED, [{ type: "done", text: 'Here it is:\n```json\n{"city":"Paris"}\n```', usage: { inputTokens: 130, outputTokens: 9 } }]]
  const chunks = await structured(afmText({ native: editing, ...PERMISSIVE }))
  assert.deepEqual(answerIn(chunks), { city: "Paris" })
  assert.equal(chunks.some((c) => c.type === "RUN_ERROR"), false)
  const [first, again] = editing.named("respond") as Array<Respond & { schema?: unknown }>
  assert.ok(first.schema)
  assert.equal(again.schema, undefined, "the answer is asked for as text")
  assert.equal(again.prompt, `Weather in Paris?\n\n${jsonAsk(CITY)}`)
  // A session of its own, with the same guardrails, and both are closed.
  const sessions = editing.named("createSession")
  assert.equal(sessions.length, 2)
  assert.notEqual(again.sessionId, first.sessionId)
  assert.deepEqual(sessions.map((session) => session.guardrails), ["permissiveContentTransformations", "permissiveContentTransformations"])
  assert.equal(editing.named("deleteSession").length, 2)
})

test("the refusal stands where the text doesn't fit the schema, where it is refused too, and where the guardrails are the default ones", async () => {
  for (const [name, config, reply, responds] of [
    // Text that doesn't fit is asked for once more, and no further.
    ["text that isn't the schema's", PERMISSIVE, [{ type: "done", text: '{"town":"Paris"}' }], 3],
    ["text without JSON", PERMISSIVE, [{ type: "done", text: "Paris" }], 3],
    ["text refused too", PERMISSIVE, REFUSED, 2],
    ["default guardrails", {}, undefined, 1]
  ] as const) {
    const editing = new EditingNative()
    editing.replies = [REFUSED, ...(reply ? [reply as Array<Event>] : [])]
    const chunks = await structured(afmText({ native: editing, ...config }))
    const failed = chunks.find((c) => c.type === "RUN_ERROR") as { code?: string } | undefined
    assert.equal(failed?.code, "guardrailViolation", name)
    assert.equal(answerIn(chunks), undefined, name)
    assert.equal(editing.named("respond").length, responds, name)
  }
  // Another error isn't asked for again.
  const editing = new EditingNative()
  editing.replies = [[{ type: "error", code: "exceededContextWindowSize", message: "Too long" }]]
  const chunks = await structured(afmText({ native: editing, ...PERMISSIVE }))
  assert.equal((chunks.find((c) => c.type === "RUN_ERROR") as { code?: string }).code, "exceededContextWindowSize")
  assert.equal(editing.named("respond").length, 1)
})

test("a refused answer that followed notes is asked for as text with the message and the notes, on either OS", async () => {
  for (const native of [new EditingNative(), new RebuildingNative()]) {
    native.replies = [NOTES, REFUSED, [{ type: "done", text: '{"city":"Paris"}' }]]
    const chunks = await structured(afmText({ native, ...PERMISSIVE }), high)
    assert.equal(reasoningIn(chunks), "Needs the weather.")
    assert.deepEqual(answerIn(chunks), { city: "Paris" })
    const asks = native.named("respond") as Array<Respond>
    assert.equal(asks.length, 3)
    assert.equal(asks[2].prompt, `${thoughtsPrompt("Weather in Paris?", "Needs the weather.")}\n\n${jsonAsk(CITY)}`)
  }
})


test("text that doesn't fit the schema is asked for a second time, and an answer half wrapped in the schema is taken out of it", async () => {
  // The schema written back, then the answer.
  const editing = new EditingNative()
  editing.replies = [REFUSED, [{ type: "done", text: JSON.stringify(CITY) }], [{ type: "done", text: '{"city":"Paris"}' }]]
  assert.deepEqual(answerIn(await structured(afmText({ native: editing, ...PERMISSIVE }))), { city: "Paris" })
  assert.equal(editing.named("respond").length, 3)
  assert.equal(editing.named("deleteSession").length, 3, "each text ask has a session of its own")

  const wrapped = new EditingNative()
  wrapped.replies = [REFUSED, [{ type: "done", text: '```json\n{"type": "object", "properties": {"city": "Paris"}}\n```' }]]
  assert.deepEqual(answerIn(await structured(afmText({ native: wrapped, ...PERMISSIVE }))), { city: "Paris" })
  assert.equal(wrapped.named("respond").length, 2)
})

const NO_LANGUAGE: Array<Event> = [{ type: "error", code: "unsupportedLanguageOrLocale", message: "Unsupported language or locale" }]

test("a structured answer's prompt the framework takes for an unsupported language is asked once more under a label in English", async () => {
  const editing = new EditingNative()
  editing.replies = [NO_LANGUAGE, ANSWER]
  const chunks = await structured(afmText({ native: editing }))
  assert.deepEqual(answerIn(chunks), { city: "Paris" })
  const [first, again] = editing.named("respond") as Array<Respond & { schema?: unknown }>
  assert.equal(first.prompt, "Weather in Paris?")
  assert.equal(again.prompt, "Message:\nWeather in Paris?")
  assert.ok(again.schema, "still held to the schema")
  assert.notEqual(again.sessionId, first.sessionId, "in a session of its own")
  assert.equal(editing.named("deleteSession").length, 2)

  // Once only: a prompt that is in an unsupported language fails as it did.
  const failing = new EditingNative()
  failing.replies = [NO_LANGUAGE, NO_LANGUAGE]
  const failed = (await structured(afmText({ native: failing }))).find((c) => c.type === "RUN_ERROR") as { code?: string }
  assert.equal(failed.code, "unsupportedLanguageOrLocale")
  assert.equal(failing.named("respond").length, 2)
})

test("an answer refused after the label is asked for as text under the label too", async () => {
  const editing = new EditingNative()
  editing.replies = [NO_LANGUAGE, REFUSED, [{ type: "done", text: '{"city":"Paris"}' }]]
  const chunks = await structured(afmText({ native: editing, ...PERMISSIVE }))
  assert.deepEqual(answerIn(chunks), { city: "Paris" })
  const asks = editing.named("respond") as Array<Respond & { schema?: unknown }>
  assert.deepEqual(asks.map((ask) => !!ask.schema), [true, true, false])
  assert.equal(asks[2].prompt, `Message:\nWeather in Paris?\n\n${jsonAsk(CITY)}`)
})

test("notes that use up maximumResponseTokens leave no session behind: the next message starts a session without the draft", async () => {
  // The same settings for both steps, so the second could go on in the first's session.
  const cap = { ...high, modelOptions: { maximumResponseTokens: 50 } }
  const editing = new EditingNative()
  editing.replies = [[{ type: "done", text: "Needs the", usage: { inputTokens: 100, outputTokens: 50 } }], NOTES, REPLY]
  const adapter = afmText({ native: editing })
  const cut: Array<Chunk> = []
  for await (const chunk of adapter.chatStream(chatOptions(cap))) cut.push(chunk as Chunk)
  assert.equal(cut.at(-1)?.finishReason, "length")
  const [first] = editing.named("respond") as Array<Respond>
  // The next message of the same thread, the cut-off step having written no reply.
  for await (const _ of adapter.chatStream(chatOptions({ ...cap, messages: [user("Weather in Paris?"), user("And in Rome?")] }))) void _
  const later = editing.named("respond") as Array<Respond>
  assert.notEqual(later[1].sessionId, first.sessionId, "the session that holds the draft isn't asked again")
  assert.ok(editing.named("deleteSession").some((call) => call.sessionId === first.sessionId), "it is ended")
})

test("a text answer that breaks a closed tuple isn't taken: the second text try that fits is", async () => {
  const editing = new EditingNative()
  editing.replies = [REFUSED, [{ type: "done", text: "[1, 2]" }], [{ type: "done", text: "[1]" }]]
  const result = await afmText({ native: editing, ...PERMISSIVE }).structuredOutput({
    chatOptions: chatOptions(),
    outputSchema: { type: "array", prefixItems: [{ type: "integer" }], items: false }
  } as never)
  assert.deepEqual(result.data, [1])
  assert.equal(editing.named("respond").length, 3)
})

test("a text answer missing a required property named like an inherited one isn't taken: the second text try that has it is", async () => {
  const editing = new EditingNative()
  editing.replies = [REFUSED, [{ type: "done", text: "{}" }], [{ type: "done", text: '{"constructor":"Kg6"}' }]]
  const result = await afmText({ native: editing, ...PERMISSIVE }).structuredOutput({
    chatOptions: chatOptions(),
    outputSchema: { type: "object", properties: { constructor: { type: "string" } }, required: ["constructor"], additionalProperties: false }
  } as never)
  assert.deepEqual(result.data, { constructor: "Kg6" })
  assert.equal(editing.named("respond").length, 3)
})

