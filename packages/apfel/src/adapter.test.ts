import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"

import { chat, toolDefinition } from "@tanstack/ai"
import type { ModelMessage, TextOptions, Tool } from "@tanstack/ai"

import { apfelText } from "./adapter.js"
import type { ApfelTextModelOptions } from "./adapter.js"
import { toolSystemPrompt } from "./tools.js"

type Chunk = { type: string; [key: string]: unknown }
type Body = Record<string, unknown> & {
  stream?: boolean
  messages: Array<{ role: string; content: string }>
}

const schema = {
  type: "object",
  properties: { moveId: { type: "string", enum: ["b6-a5"] } },
  required: ["moveId"],
  additionalProperties: false
}
const noop = () => undefined
const logger = {
  request: noop,
  provider: noop,
  errors: noop,
  warn: noop
} as unknown as TextOptions["logger"]
const baseURL = "http://apfel.test/v1"

const usage = { prompt_tokens: 30, completion_tokens: 5 }

/** apfel's streamed chunks for a reply, in these pieces. */
const textChunks = (pieces: Array<string>, finish = "stop") => [
  { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
  ...pieces.map((content) => ({
    choices: [{ delta: { content }, finish_reason: null }]
  })),
  { choices: [{ delta: {}, finish_reason: finish }] },
  { choices: [], usage }
]

/** What the fake apfel server does, per test. */
const server = {
  requests: [] as Array<{ body: Body; init: RequestInit }>,
  /** The streamed reply's chunks. */
  chunks: [] as Array<unknown>,
  /** Non-streamed replies' contents, in order (the last one repeats). */
  contents: [] as Array<string>,
  finish: "stop",
  status: 200,
  /** Called before each streamed chunk. */
  beforeChunk: noop as (index: number) => void,
  /** Streamed chunks sent, for the early stop. */
  sent: 0
}

/** apfel's SSE reply. Like fetch's body, it errors once the request's signal aborts. */
const sse = (
  chunks: Array<unknown>,
  before: (index: number) => void,
  signal?: AbortSignal | null
) => {
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          before(index)
          if (signal?.aborted) return controller.error(signal.reason)
          server.sent++
          const line =
            index < chunks.length
              ? `data: ${JSON.stringify(chunks[index])}\n\n`
              : "data: [DONE]\n\n"
          controller.enqueue(new TextEncoder().encode(line))
          if (index++ >= chunks.length) controller.close()
        }
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "text/event-stream" } }
  )
}

const original = globalThis.fetch
beforeEach(() => {
  server.requests = []
  server.chunks = textChunks(["Hello", " there."])
  server.contents = ['{"moveId":"b6-a5"}']
  server.finish = "stop"
  server.status = 200
  server.beforeChunk = noop
  server.sent = 0
  globalThis.fetch = async (_url, init = {}) => {
    init.signal?.throwIfAborted()
    const body = JSON.parse(String(init.body)) as Body
    server.requests.push({ body, init })
    if (server.status !== 200) {
      return new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: server.status
      })
    }
    if (!body.stream) {
      const content =
        server.contents.length > 1 ? server.contents.shift() : server.contents[0]
      return new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: server.finish }],
          usage
        }),
        { headers: { "content-type": "application/json" } }
      )
    }
    return sse(server.chunks, (index) => server.beforeChunk(index), init.signal)
  }
})
afterEach(() => {
  globalThis.fetch = original
})

const adapter = () => apfelText("apple-foundationmodel", { baseURL })

async function collect(source: AsyncIterable<unknown>) {
  const chunks: Array<Chunk> = []
  for await (const chunk of source) chunks.push(chunk as Chunk)
  return chunks
}

const typesOf = (chunks: Array<Chunk>) =>
  chunks.map((c) => (c.type === "CUSTOM" ? `CUSTOM:${String(c.name)}` : c.type))

const weatherSchema = {
  type: "object",
  properties: { city: { type: "string", minLength: 1 } },
  required: ["city"]
}
const weatherTool: Tool = {
  name: "get_weather",
  description: "Weather for a city",
  inputSchema: weatherSchema
}
const clockTool: Tool = { name: "clock", description: "The time" }

const chatOptions = (
  extra: Partial<TextOptions<ApfelTextModelOptions>> = {}
): TextOptions<ApfelTextModelOptions> =>
  ({
    model: "apple-foundationmodel",
    logger,
    threadId: "thread",
    messages: [{ role: "user", content: "Weather in Kyoto?" }],
    ...extra
  }) as TextOptions<ApfelTextModelOptions>

const fence = (json: string) => "```tool_call\n" + json + "\n```"

test("modelOptions take only standard names", () => {
  // @ts-expect-error maxTokens is maxCompletionTokens.
  const maxTokens: ApfelTextModelOptions = { maxTokens: 1 }
  // @ts-expect-error tools aren't sent to apfel.
  const parallel: ApfelTextModelOptions = { parallelToolCalls: false }
  assert.ok(maxTokens && parallel)
})

test("chatStream sends one streamed request: the tools in the system prompt, no tool fields, and sampling", async () => {
  await collect(
    adapter().chatStream(
      chatOptions({
        systemPrompts: ["Be brief."],
        tools: [weatherTool],
        toolChoice: "required",
        modelOptions: { maxCompletionTokens: 64, temperature: 0.2, topP: 0.9, seed: 7 }
      })
    )
  )
  assert.equal(server.requests.length, 1)
  assert.deepEqual(server.requests[0].body, {
    model: "apple-foundationmodel",
    max_tokens: 64,
    temperature: 0.2,
    top_p: 0.9,
    seed: 7,
    messages: [
      { role: "system", content: toolSystemPrompt("Be brief.", [weatherTool]) },
      { role: "user", content: "Weather in Kyoto?" }
    ],
    stream: true,
    stream_options: { include_usage: true }
  })
})

test("toolChoice none leaves the tools out of the prompt", async () => {
  await collect(
    adapter().chatStream(
      chatOptions({ systemPrompts: ["Be brief."], tools: [weatherTool], toolChoice: "none" })
    )
  )
  assert.deepEqual(server.requests[0].body.messages[0], {
    role: "system",
    content: "Be brief."
  })
})

test("streamed text arrives as TEXT_MESSAGE_* events, with usage and timings", async () => {
  const chunks = await collect(adapter().chatStream(chatOptions({ runId: "run-1" })))
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ])
  assert.deepEqual(
    chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").map((c) => c.content),
    ["Hello", "Hello there."]
  )
  const finished = chunks.at(-1) as Chunk & {
    usage: Record<string, unknown> & { providerUsageDetails: Record<string, number> }
  }
  assert.equal(finished.runId, "run-1")
  assert.equal(finished.finishReason, "stop")
  assert.equal(finished.usage.totalTokens, 35)
  assert.equal(typeof finished.usage.providerUsageDetails.firstTokenMs, "number")
  assert.equal(typeof finished.usage.providerUsageDetails.decodeMs, "number")
})

test("a fenced call, split across chunks, becomes TOOL_CALL_* events and stops apfel", async () => {
  server.chunks = textChunks([
    "Let me check. ``",
    '`tool_call\n{"name": "get_weather", ',
    '"arguments": {"city": "Kyoto"}}\n``',
    "`",
    "This is never read.",
    "Nor this."
  ])
  const chunks = await collect(
    adapter().chatStream(chatOptions({ tools: [weatherTool] }))
  )
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
  assert.equal(chunks[2].content, "Let me check. ")
  const [start, args, end] = chunks.slice(4, 7)
  assert.equal(start.toolCallName, "get_weather")
  assert.equal(args.args, '{"city":"Kyoto"}')
  assert.equal(end.toolCallId, start.toolCallId)
  assert.deepEqual(end.input, { city: "Kyoto" })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  assert.equal((server.requests[0].init.signal as AbortSignal).aborted, true)
  assert.ok(server.sent <= 5, "the request stopped at the call")
  assert.equal(server.requests.length, 1, "a valid call needs no repair")
})

test("a call with arguments that fail its schema is repaired once, held to the tool's schema", async () => {
  server.chunks = textChunks([fence('{"name": "get_weather", "arguments": {"town": "Kyoto"}}')])
  server.contents = ['{"city": "Kyoto"}']
  const chunks = await collect(
    adapter().chatStream(chatOptions({ tools: [weatherTool, clockTool] }))
  )
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "RUN_FINISHED"
  ])
  assert.deepEqual(chunks[3].input, { city: "Kyoto" })
  assert.equal(server.requests.length, 2)
  const repair = server.requests[1].body
  assert.equal(repair.stream, undefined)
  // minLength is left out: apfel can't enforce it.
  assert.deepEqual(repair.response_format, {
    type: "json_schema",
    json_schema: {
      name: "output",
      schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
    }
  })
  assert.deepEqual(repair.messages.slice(-2), [
    {
      role: "assistant",
      content: fence('{"name": "get_weather", "arguments": {"town": "Kyoto"}}')
    },
    {
      role: "user",
      content: "That tool call wasn't valid: arguments.city is missing. Write it again."
    }
  ])
})

test("a fence that isn't JSON, or names an unknown tool, is repaired with the name first, then its arguments", async () => {
  for (const broken of ['{"name": "get_weather", "arguments": {city: Kyoto}}', '{"name": "weather", "arguments": {}}']) {
    server.requests = []
    server.chunks = textChunks([fence(broken)])
    server.contents = ['{"name": "get_weather"}', '{"city": "Kyoto"}']
    const chunks = await collect(
      adapter().chatStream(chatOptions({ tools: [weatherTool, clockTool] }))
    )
    assert.deepEqual(chunks.find((c) => c.type === "TOOL_CALL_END")?.input, { city: "Kyoto" })
    assert.equal(server.requests.length, 3)
    const format = (i: number) =>
      (server.requests[i].body.response_format as { json_schema: { schema: unknown } }).json_schema.schema
    assert.deepEqual(format(1), {
      type: "object",
      properties: { name: { type: "string", enum: ["get_weather", "clock"] } },
      required: ["name"]
    })
    assert.deepEqual(format(2), { type: "object", properties: { city: { type: "string" } }, required: ["city"] })
  }
})

test("a repair that fails too shows the fence as text, without trying again", async () => {
  const broken = fence('{"name": "get_weather", "arguments": {"town": "Kyoto"}}')
  server.chunks = textChunks(["Checking. ", broken])
  server.contents = ['{"town": "Kyoto"}']
  const chunks = await collect(
    adapter().chatStream(chatOptions({ tools: [weatherTool] }))
  )
  assert.equal(chunks.some((c) => c.type.startsWith("TOOL_CALL")), false)
  assert.equal(chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").at(-1)?.content, `Checking. ${broken}`)
  assert.equal(chunks.at(-1)?.finishReason, "stop")
  assert.equal(server.requests.length, 2)
})

test("tool calls and results in the history are written as the Prompt API adapter writes them", async () => {
  const messages: Array<ModelMessage> = [
    { role: "user", content: "Weather in Kyoto and Oslo?" },
    {
      role: "assistant",
      content: "Checking.",
      toolCalls: [
        { id: "a", type: "function", function: { name: "get_weather", arguments: '{"city":"Kyoto"}' } },
        { id: "b", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }
      ]
    },
    { role: "tool", toolCallId: "a", content: '{"tempC":18}' },
    { role: "tool", toolCallId: "b", content: "", error: "offline" },
    { role: "assistant", content: "18°C in Kyoto." }
  ]
  await collect(adapter().chatStream(chatOptions({ messages })))
  assert.deepEqual(server.requests[0].body.messages, [
    { role: "user", content: "Weather in Kyoto and Oslo?" },
    {
      role: "assistant",
      content:
        'Checking.\n```tool_call\n{"name":"get_weather","arguments":{"city":"Kyoto"},"id":"a"}\n{"name":"get_weather","arguments":{"city":"Oslo"},"id":"b"}\n```'
    },
    {
      role: "user",
      content:
        '```tool_result\n{"name":"get_weather","result":{"tempC":18},"error":false,"id":"a"}\n{"name":"get_weather","result":"offline","error":true,"id":"b"}\n```'
    },
    { role: "assistant", content: "18°C in Kyoto." }
  ])
})

test("an HTTP error ends the run with RUN_ERROR", async () => {
  server.status = 400
  const chunks = await collect(adapter().chatStream(chatOptions()))
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(chunks[1].message, "apfel returned HTTP 400: busy")
})

test("an unreachable apfel ends the run with RUN_ERROR", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch")
  }
  const chunks = await collect(adapter().chatStream(chatOptions()))
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "RUN_ERROR"])
  assert.match(String(chunks[1].message), /Failed to fetch/)
})

test("an abort stops the request and ends the stream quietly", async () => {
  const controller = new AbortController()
  server.beforeChunk = (index) => {
    if (index === 2) controller.abort()
  }
  const chunks = await collect(
    adapter().chatStream(chatOptions({ abortController: controller }))
  )
  assert.equal((server.requests[0].init.signal as AbortSignal).aborted, true)
  assert.equal(chunks.some((c) => c.type === "RUN_FINISHED" || c.type === "RUN_ERROR"), false)
  const aborted = new AbortController()
  aborted.abort()
  server.requests = []
  const none = await collect(adapter().chatStream(chatOptions({ abortController: aborted })))
  assert.deepEqual(typesOf(none), ["RUN_STARTED"])
  assert.equal(server.requests.length, 0)
})

test("chat() runs the tool loop end to end: the call, the tool, then the answer", async () => {
  let calls = 0
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as Body
    server.requests.push({ body, init })
    calls++
    return sse(
      textChunks([calls === 1 ? fence('{"name": "get_weather", "arguments": {"city": "Kyoto"}}') : "18°C and cloudy."]),
      noop,
      init.signal
    )
  }
  const getWeather = toolDefinition({
    name: "get_weather",
    description: "Weather for a city",
    inputSchema: weatherSchema
  }).server(async () => ({ tempC: 18, sky: "cloudy" }))
  const { text } = await chat({
    adapter: adapter(),
    messages: [{ role: "user", content: "Weather in Kyoto?" }],
    tools: [getWeather],
    threadId: "thread",
    stream: false
  })
  assert.equal(text, "18°C and cloudy.")
  assert.equal(server.requests.length, 2)
  const second = server.requests[1].body.messages
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.match(second[2].content, /^```tool_call\n\{"name":"get_weather","arguments":\{"city":"Kyoto"\},"id":"[^"]+"\}\n```$/)
  assert.match(second[3].content, /^```tool_result\n\{"name":"get_weather","result":\{"tempC":18,"sky":"cloudy"\},"error":false,"id":"[^"]+"\}\n```$/)
})

const structuredOptions = (extra: Record<string, unknown> = {}) => ({
  chatOptions: {
    model: "apple-foundationmodel",
    logger,
    threadId: "thread",
    messages: [{ role: "user" as const, content: "Choose a move" }],
    ...extra
  } as TextOptions<ApfelTextModelOptions>,
  outputSchema: schema
})

test("structuredOutput sends one json_schema request with the schema as given, and parses the JSON", async () => {
  const result = await adapter().structuredOutput(
    structuredOptions({ modelOptions: { maxCompletionTokens: 64 } })
  )
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  assert.equal(result.rawText, '{"moveId":"b6-a5"}')
  assert.equal(result.usage?.totalTokens, 35)
  const { body } = server.requests[0]
  assert.equal(body.stream, undefined)
  assert.equal(body.max_tokens, 64)
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "output", schema }
  })
})

test("structuredOutput rejects an answer cut off at the token limit, one that isn't JSON, and an HTTP error", async () => {
  server.finish = "length"
  await assert.rejects(adapter().structuredOutput(structuredOptions()), /cut off/)
  server.finish = "stop"
  server.contents = ["not json"]
  await assert.rejects(adapter().structuredOutput(structuredOptions()), SyntaxError)
  server.status = 500
  await assert.rejects(
    adapter().structuredOutput(structuredOptions()),
    /apfel returned HTTP 500: busy/
  )
})

test("chat({ outputSchema, stream: true }) streams the answer from structuredOutput", async () => {
  const chunks = await collect(
    chat({
      adapter: adapter(),
      threadId: "thread",
      messages: [{ role: "user", content: "Choose a move" }],
      outputSchema: schema,
      stream: true
    }) as AsyncIterable<unknown>
  )
  const complete = chunks.find(
    (c) => c.type === "CUSTOM" && c.name === "structured-output.complete"
  )
  assert.deepEqual((complete?.value as { object: unknown }).object, { moveId: "b6-a5" })
  assert.equal(chunks.at(-1)?.type, "RUN_FINISHED")
})
