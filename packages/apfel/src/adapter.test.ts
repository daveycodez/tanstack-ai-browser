import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { chat } from "@tanstack/ai"

import { apfelText } from "./adapter.js"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** apfel's streamed reply: the chunks, then [DONE]. */
function sse(chunks: Array<object>) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
const chunk = (delta: object, finish: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 0,
  model: "apple-foundationmodel",
  choices: [{ index: 0, delta, finish_reason: finish }]
})

test("a chat goes to apfel's Chat Completions with tools, and OpenRouter-style options with OpenAI's names", async () => {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input instanceof Request ? input.url : input), "http://apfel.test/v1/chat/completions")
    bodies.push(JSON.parse(String(init?.body ?? (input as Request).body)))
    return sse([chunk({ role: "assistant", content: "Hi" }), chunk({}, "stop")])
  }) as typeof fetch
  const weather = { name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } }
  const text = await chat({
    adapter: apfelText("apple-foundationmodel", { baseURL: "http://apfel.test/v1" }),
    threadId: "apfel-test",
    messages: [{ role: "user", content: "hey" }],
    tools: [weather],
    modelOptions: { max_tokens: 64, temperature: 0.2, top_p: 0.9, seed: 1 },
    stream: false
  })
  assert.equal(typeof text === "string" ? text : text.text, "Hi")
  const body = bodies[0]
  assert.equal(body.model, "apple-foundationmodel")
  assert.equal(body.max_tokens, 64)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.top_p, 0.9)
  assert.equal(body.seed, 1)
  assert.equal((body.tools as Array<{ function: { name: string } }>)[0].function.name, "get_weather")
})

test("Apple's model takes images, sent to apfel as image_url parts with a data URL", async () => {
  const bodies: Array<{ messages: Array<{ content: unknown }> }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? (input as Request).body)))
    return sse([chunk({ role: "assistant", content: "A blue circle." }), chunk({}, "stop")])
  }) as typeof fetch
  const adapter = apfelText({ baseURL: "http://apfel.test/v1" })
  assert.deepEqual(adapter.inputModalities, ["text", "image"])
  assert.equal(apfelText("some-other-model").inputModalities, undefined)
  await chat({
    adapter,
    threadId: "apfel-image-test",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", content: "What is this?" },
          { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" } }
        ]
      }
    ],
    stream: false
  })
  const content = bodies[0].messages.at(-1)?.content as Array<{ type: string; image_url?: { url: string } }>
  assert.deepEqual(
    content.map((p) => p.type),
    ["text", "image_url"]
  )
  assert.equal(content[1].image_url?.url, "data:image/png;base64,iVBORw0KGgo=")
})

/** A chunk with only the request's usage, as apfel ends a stream asked for it. */
const usage = (prompt: number, completion: number) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 0,
  model: "apple-foundationmodel",
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
})
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: Array<unknown>; max_tokens?: number }
/** apfel answering each request in turn with `replies`; the requests' bodies. */
function serve(replies: Array<Array<object>>) {
  const bodies: Array<Body> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? (input as Request).body)))
    return sse(replies[bodies.length - 1] ?? [chunk({ role: "assistant", content: "?" }), chunk({}, "stop")])
  }) as typeof fetch
  return bodies
}
type Chunk = { type: string; delta?: string; finishReason?: string; usage?: Record<string, unknown> }
async function collect(stream: AsyncIterable<unknown>) {
  const chunks: Array<Chunk> = []
  for await (const c of stream) chunks.push(c as Chunk)
  return chunks
}
const typed = (chunks: Array<Chunk>, type: string) => chunks.filter((c) => c.type === type)
const textOf = (chunks: Array<Chunk>, type: string) =>
  typed(chunks, type)
    .map((c) => c.delta)
    .join("")
const NOTES = [chunk({ role: "assistant", content: "Needs " }), chunk({ content: "the weather." }), chunk({}, "stop"), usage(100, 5)]
const REPLY = [chunk({ role: "assistant", content: "Sunny." }), chunk({}, "stop"), usage(110, 3)]
const weather = { name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } }
/** The draft's last message at a user's message: the instruction above the message. */
const DRAFT = (message: string) =>
  `Instructions:\nWrite notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet.\n\nMessage:\n${message}`
const DRAFT_AFTER_TOOL =
  "Instructions:\nNow write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."

test("reasoning high: a request drafts working notes, streamed as reasoning, and a second replies with them, in one run", async () => {
  const bodies = serve([NOTES, REPLY])
  const chunks = await collect(
    chat({
      adapter: apfelText({ baseURL: "http://apfel.test/v1" }),
      threadId: "apfel-thinking",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: [weather],
      reasoning: "high"
    })
  )
  assert.equal(bodies.length, 2)
  // The draft: the instruction above the message, in one message, with the step's tools so the notes can plan one.
  assert.deepEqual(
    bodies[0].messages.map((m) => [m.role, m.content]),
    [["user", DRAFT("Weather in Paris?")]]
  )
  assert.equal(bodies[0].tools?.length, 1)
  // The reply: the message, then the notes under it, in one message.
  assert.deepEqual(
    bodies[1].messages.map((m) => [m.role, m.content]),
    [["user", "Message:\nWeather in Paris?\n\nNotes:\nNeeds the weather."]]
  )
  assert.equal(bodies[1].tools?.length, 1)
  assert.equal(textOf(chunks, "REASONING_MESSAGE_CONTENT"), "Needs the weather.")
  assert.equal(textOf(chunks, "TEXT_MESSAGE_CONTENT"), "Sunny.")
  const marks = ["RUN_STARTED", "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_END", "REASONING_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_END", "RUN_FINISHED"]
  assert.deepEqual(
    chunks.map((c) => c.type).filter((t) => marks.includes(t)),
    marks
  )
  // Both requests' tokens; the notes' are the step's reasoning tokens.
  const finished = typed(chunks, "RUN_FINISHED")[0]
  assert.equal(finished.usage?.promptTokens, 210)
  assert.equal(finished.usage?.completionTokens, 8)
  assert.equal(finished.usage?.totalTokens, 218)
  assert.deepEqual(finished.usage?.completionTokensDetails, { reasoningTokens: 5 })
})

test("reasoning off, or none: one request, as it was", async () => {
  for (const reasoning of ["off", undefined] as const) {
    const bodies = serve([REPLY])
    const chunks = await collect(
      chat({ adapter: apfelText({ baseURL: "http://apfel.test/v1" }), threadId: "apfel-off", messages: [{ role: "user", content: "Hi" }], ...(reasoning && { reasoning }) })
    )
    assert.equal(bodies.length, 1)
    assert.deepEqual(bodies[0].messages, [{ role: "user", content: "Hi" }])
    assert.equal(typed(chunks, "REASONING_MESSAGE_CONTENT").length, 0)
    assert.equal(textOf(chunks, "TEXT_MESSAGE_CONTENT"), "Sunny.")
  }
})

test("a tool call the draft makes is the step's call, and no reply is asked for; the next step's notes are about the tool's result", async () => {
  const call = [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }),
    chunk({}, "tool_calls"),
    usage(100, 9)
  ]
  const bodies = serve([call, NOTES, REPLY])
  const chunks = await collect(
    chat({
      adapter: apfelText({ baseURL: "http://apfel.test/v1" }),
      threadId: "apfel-draft-call",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: [{ ...weather, execute: async () => ({ temperature: "20C" }) }],
      reasoning: "high"
    })
  )
  assert.equal(bodies.length, 3)
  assert.equal(bodies[0].messages.at(-1)?.content, DRAFT("Weather in Paris?"))
  // After the tool's result: a draft about it, then the reply.
  assert.deepEqual(
    bodies[1].messages.map((m) => m.role),
    ["user", "assistant", "tool", "user"]
  )
  assert.equal(bodies[1].messages.at(-1)?.content, DRAFT_AFTER_TOOL)
  assert.equal(bodies[2].messages.at(-1)?.content, "Notes:\nNeeds the weather.")
  assert.equal(typed(chunks, "TOOL_CALL_START").length, 1)
  assert.equal(textOf(chunks, "REASONING_MESSAGE_CONTENT"), "Needs the weather.")
  assert.equal(textOf(chunks, "TEXT_MESSAGE_CONTENT"), "Sunny.")
})

test("a turn's notes stay for the turn: the step with a tool's results reads the earlier step's, and the next turn reads none", async () => {
  const call = [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }),
    chunk({}, "tool_calls"),
    usage(120, 9)
  ]
  const second = [chunk({ role: "assistant", content: "It is 20C." }), chunk({}, "stop"), usage(140, 4)]
  const bodies = serve([NOTES, call, second, REPLY, NOTES, REPLY])
  const adapter = apfelText({ baseURL: "http://apfel.test/v1" })
  const asking = { adapter, threadId: "apfel-turn", tools: [{ ...weather, execute: async () => ({ temperature: "20C" }) }], reasoning: "high" as const }
  await collect(chat({ ...asking, messages: [{ role: "user", content: "Weather in Paris?" }] }))
  const last = (body: Body, from: number) => body.messages.slice(from).map((m) => m.content)
  // The message's step: notes, then a reply that calls the tool.
  assert.deepEqual(last(bodies[0], -1), [DRAFT("Weather in Paris?")])
  assert.deepEqual(last(bodies[1], -1), ["Message:\nWeather in Paris?\n\nNotes:\nNeeds the weather."])
  // The result's step: the message as the user wrote it, the earlier notes, then the instruction about the result. No earlier instruction.
  assert.equal(bodies[2].messages[0].content, "Weather in Paris?")
  assert.deepEqual(last(bodies[2], -2), ["Notes:\nNeeds the weather.", DRAFT_AFTER_TOOL])
  assert.equal(JSON.stringify(bodies[2].messages).includes("message below"), false)
  // Its reply reads both steps' notes.
  assert.deepEqual(last(bodies[3], -1), ["Notes:\nNeeds the weather.\n\nIt is 20C."])

  // The next turn starts without them.
  await collect(chat({ ...asking, messages: [{ role: "user", content: "Weather in Paris?" }, { role: "assistant", content: "Sunny." }, { role: "user", content: "And tomorrow?" }] }))
  assert.deepEqual(last(bodies[4], -1), [DRAFT("And tomorrow?")])
  assert.equal(JSON.stringify(bodies[4].messages).includes("It is 20C."), false)
  assert.deepEqual(last(bodies[5], -1), ["Message:\nAnd tomorrow?\n\nNotes:\nNeeds the weather."])
})

test("budgetTokens caps the notes, and max_tokens covers the notes and the reply; a budget of none is no notes", async () => {
  const ask = async (reasoning: { level: "high"; budgetTokens?: number }, max_tokens?: number) => {
    const bodies = serve([NOTES, REPLY])
    await collect(
      chat({
        adapter: apfelText({ baseURL: "http://apfel.test/v1" }),
        threadId: "apfel-budget",
        messages: [{ role: "user", content: "Hi" }],
        reasoning,
        ...(max_tokens !== undefined && { modelOptions: { max_tokens } })
      })
    )
    return bodies.map((b) => b.max_tokens)
  }
  assert.deepEqual(await ask({ level: "high" }), [undefined, undefined])
  assert.deepEqual(await ask({ level: "high", budgetTokens: 40 }), [40, undefined])
  // The notes took 5 of the 64.
  assert.deepEqual(await ask({ level: "high" }, 64), [64, 59])
  assert.deepEqual(await ask({ level: "high", budgetTokens: 40 }, 64), [40, 59])
  assert.deepEqual(await ask({ level: "high", budgetTokens: 100 }, 64), [64, 59])
  assert.deepEqual(await ask({ level: "high", budgetTokens: 0 }), [undefined])
})

test("empty notes are no reasoning, and the reply is to the message as it is", async () => {
  const bodies = serve([[chunk({}, "stop"), usage(100, 0)], REPLY])
  const chunks = await collect(
    chat({ adapter: apfelText({ baseURL: "http://apfel.test/v1" }), threadId: "apfel-empty", messages: [{ role: "user", content: "Hi" }], reasoning: "high" })
  )
  assert.deepEqual(bodies[1].messages, [{ role: "user", content: "Hi" }])
  assert.equal(typed(chunks, "REASONING_START").length, 0)
  assert.equal(textOf(chunks, "TEXT_MESSAGE_CONTENT"), "Sunny.")
})
