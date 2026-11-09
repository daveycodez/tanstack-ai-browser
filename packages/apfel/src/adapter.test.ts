import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"

import { apfelText } from "./adapter.js"
import type { ApfelTextModelOptions, ApfelConfig } from "./adapter.js"

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

/** What the fake apfel server does, per test. */
const server = {
  requests: [] as Array<{ body: Body; init: RequestInit }>,
  /** The final answer's content, streamed in these pieces. */
  answer: ['{"moveId":', '"b6-a5"}'],
  finish: "stop",
  status: 200,
  /** Answer streamed requests with plain JSON, as a non-streaming server would. */
  ignoreStream: false,
  /** Called before each streamed piece of the final answer. */
  beforePiece: noop as (index: number) => void
}

const sse = (
  chunks: Array<unknown>,
  before: (index: number) => void = noop
) => {
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          before(index)
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
  server.answer = ['{"moveId":', '"b6-a5"}']
  server.finish = "stop"
  server.status = 200
  server.ignoreStream = false
  server.beforePiece = noop
  globalThis.fetch = async (_url, init = {}) => {
    init.signal?.throwIfAborted()
    const body = JSON.parse(String(init.body)) as Body
    server.requests.push({ body, init })
    if (server.status !== 200) {
      return new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: server.status
      })
    }
    const draft = body.messages
      .at(-1)
      ?.content.includes("write notes for yourself")
    if (draft) {
      return sse([
        { choices: [{ delta: { content: "think " } }] },
        { choices: [{ delta: { content: "first" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } }
      ])
    }
    const usage = { prompt_tokens: 30, completion_tokens: 5 }
    if (!body.stream || server.ignoreStream) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: server.answer.join("") },
              finish_reason: server.finish
            }
          ],
          usage
        }),
        { headers: { "content-type": "application/json" } }
      )
    }
    return sse(
      [
        ...server.answer.map((content, i) => ({
          choices: [
            {
              delta: { content },
              finish_reason:
                i === server.answer.length - 1 ? server.finish : null
            }
          ]
        })),
        { choices: [], usage }
      ],
      (index) => server.beforePiece(index)
    )
  }
})
afterEach(() => {
  globalThis.fetch = original
})

const adapter = () => apfelText("apple-foundationmodel", { baseURL })
const options = (extra: Record<string, unknown> = {}) => ({
  chatOptions: {
    model: "apple-foundationmodel",
    logger,
    threadId: "thread",
    messages: [{ role: "user" as const, content: "Choose a move" }],
    ...extra
  },
  outputSchema: schema
})

async function collect(source: AsyncIterable<unknown>) {
  const chunks: Array<Chunk> = []
  for await (const chunk of source) chunks.push(chunk as Chunk)
  return chunks
}

const typesOf = (chunks: Array<Chunk>) =>
  chunks.map((c) => (c.type === "CUSTOM" ? `CUSTOM:${String(c.name)}` : c.type))

test("the config and modelOptions take only standard names", () => {
  // @ts-expect-error onThinking was removed: reasoning streams as REASONING_* events.
  const thinking: ApfelConfig = { onThinking: noop }
  // @ts-expect-error onGenerationPhase was removed.
  const phases: ApfelConfig = { onGenerationPhase: noop }
  // @ts-expect-error maxTokens is now maxCompletionTokens.
  const maxTokens: ApfelTextModelOptions = { maxTokens: 1 }
  // @ts-expect-error max_tokens is now maxCompletionTokens.
  const snake: ApfelTextModelOptions = { max_tokens: 1 }
  assert.ok(thinking && phases && maxTokens && snake)
})

test("structuredOutputStream sends one streamed JSON-schema request and emits the standard events", async () => {
  const chunks = await collect(
    adapter().structuredOutputStream(
      options({
        runId: "run-1",
        modelOptions: {
          maxCompletionTokens: 64,
          temperature: 0.2,
          topP: 0.9,
          seed: 7
        }
      })
    )
  )
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "CUSTOM:structured-output.complete",
    "RUN_FINISHED"
  ])
  assert.equal(server.requests.length, 1)
  const { body } = server.requests[0]
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "output", schema }
  })
  assert.equal(body.max_tokens, 64)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.top_p, 0.9)
  assert.equal(body.seed, 7)
  for (const name of ["maxCompletionTokens", "topP", "maxTokens"]) {
    assert.equal(name in body, false)
  }
  assert.deepEqual(
    chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").map((c) => c.delta),
    ['{"moveId":', '"b6-a5"}']
  )
  assert.deepEqual(chunks.find((c) => c.type === "CUSTOM")?.value, {
    object: { moveId: "b6-a5" },
    raw: '{"moveId":"b6-a5"}'
  })
  const finished = chunks.at(-1)
  assert.equal(finished?.runId, "run-1")
  assert.equal(finished?.finishReason, "stop")
  assert.deepEqual(
    {
      promptTokens: (finished?.usage as { promptTokens: number }).promptTokens,
      completionTokens: (finished?.usage as { completionTokens: number })
        .completionTokens
    },
    { promptTokens: 30, completionTokens: 5 }
  )
  for (const chunk of chunks) {
    assert.equal(typeof chunk.timestamp, "number")
    assert.deepEqual(
      (chunk.metadata as { tanstack: { source: unknown } }).tanstack.source,
      {
        provider: "apfel",
        api: "openai-completions",
        model: "apple-foundationmodel"
      }
    )
  }
})

test("emulated reasoning streams as REASONING_* events from the draft, then the JSON", async () => {
  const chunks = await collect(
    adapter().structuredOutputStream(
      options({ reasoning: { level: "high", budgetTokens: 16 } })
    )
  )
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
    "CUSTOM:structured-output.complete",
    "RUN_FINISHED"
  ])
  assert.equal(server.requests.length, 2)
  assert.equal(server.requests[0].body.max_tokens, 16)
  // The notes follow the conversation in a message of their own, as with the Prompt API.
  const final = server.requests[1].body.messages
  assert.equal(final[0].content, "Choose a move")
  assert.match(
    final.at(-1)?.content ?? "",
    /^Working notes to verify against the conversation:\nthink first/
  )
  const complete = chunks.find((c) => c.type === "CUSTOM")
  assert.equal(
    (complete?.value as { reasoning: string }).reasoning,
    "think first"
  )
  const usage = chunks.at(-1)?.usage as {
    promptTokens: number
    completionTokens: number
    completionTokensDetails: { reasoningTokens: number }
    providerUsageDetails: Record<string, unknown>
  }
  assert.equal(usage.promptTokens, 50)
  assert.equal(usage.completionTokens, 7)
  assert.equal(usage.completionTokensDetails.reasoningTokens, 2)
  assert.equal(usage.providerUsageDetails.reasoningEmulated, true)
})

test("a server that answers without streaming still gives the standard events", async () => {
  server.ignoreStream = true
  const chunks = await collect(adapter().structuredOutputStream(options()))
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "CUSTOM:structured-output.complete",
    "RUN_FINISHED"
  ])
})

test("errors end the stream with RUN_ERROR and a code", async () => {
  server.answer = ["not json"]
  let chunks = await collect(adapter().structuredOutputStream(options()))
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal(chunks.at(-1)?.code, "parse-error")

  server.answer = ['{"moveId":']
  server.finish = "length"
  chunks = await collect(adapter().structuredOutputStream(options()))
  assert.equal(chunks.at(-1)?.code, "max_tokens")
  assert.match(String(chunks.at(-1)?.message), /maxCompletionTokens/)

  server.status = 503
  chunks = await collect(adapter().structuredOutputStream(options()))
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "RUN_ERROR"])
  assert.match(String(chunks[1].message), /HTTP 503: busy/)
})

test("an abort mid-answer ends with RUN_ERROR aborted", async () => {
  const controller = new AbortController()
  server.beforePiece = (index) => {
    if (index === 1) controller.abort(new Error("stop now"))
  }
  const chunks = await collect(
    adapter().structuredOutputStream(
      options({ request: { signal: controller.signal } })
    )
  )
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal(chunks.at(-1)?.code, "aborted")
  assert.equal(chunks.at(-1)?.message, "stop now")
  assert.ok(!chunks.some((c) => c.type === "RUN_FINISHED"))
})

test("structuredOutput still sends one non-streamed request", async () => {
  const result = await adapter().structuredOutput(
    options({ modelOptions: { maxCompletionTokens: 32 } })
  )
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].body.stream, undefined)
  assert.equal(server.requests[0].body.max_tokens, 32)
  assert.equal(result.usage?.completionTokens, 5)
})

test("chat({ outputSchema, stream: true }) runs end to end on the adapter's stream", async () => {
  const chunks = await collect(
    chat({
      adapter: adapter(),
      threadId: "chat-thread",
      messages: [{ role: "user", content: "Choose a move" }],
      outputSchema: schema,
      stream: true
    })
  )
  const complete = chunks.find(
    (c) => c.type === "CUSTOM" && c.name === "structured-output.complete"
  )
  assert.deepEqual((complete?.value as { object: unknown }).object, {
    moveId: "b6-a5"
  })
  assert.equal(chunks.at(-1)?.type, "RUN_FINISHED")
  assert.equal(server.requests[0].body.stream, true)

  const value = await chat({
    adapter: adapter(),
    threadId: "chat-thread-2",
    messages: [{ role: "user", content: "Choose a move" }],
    outputSchema: schema
  })
  assert.deepEqual(value, { moveId: "b6-a5" })
})

const weatherTools = [
  {
    name: "get_weather",
    description: "Weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" }, days: { type: "integer" } },
      required: ["city"]
    }
  },
  { name: "get_current_location", description: "Where the user is" }
]

const TOOL_LIST =
  "You can use these tools:\n- get_weather: Weather for a city\n- get_current_location: Where the user is\nUse a tool when the user asks for one or the answer needs current or outside information; otherwise answer directly. Once you have a tool's result, answer from it."

type Format = {
  json_schema: {
    name: string
    schema: { properties: Record<string, { enum?: Array<string> }> }
  }
}
const formatOf = (body: Body) => body.response_format as Format

/**
 * Answers each guided request by its schema's name (`decision`, or a tool's
 * name for its arguments), and a streamed request with text.
 */
function stepServer(replies: Record<string, unknown>) {
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as Body
    server.requests.push({ body, init })
    if (!body.stream) {
      const name = formatOf(body).json_schema.name
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(replies[name]) } }],
          usage: { prompt_tokens: 40, completion_tokens: 5 }
        })
      )
    }
    return sse([
      { choices: [{ delta: { content: "Sunny " } }] },
      { choices: [{ delta: { content: "in Tokyo." }, finish_reason: "stop" }] }
    ])
  }
}

const weatherRun = (extra: Partial<TextOptions<ApfelTextModelOptions>> = {}) =>
  collect(
    adapter().chatStream({
      model: "apple-foundationmodel",
      logger,
      threadId: "thread",
      systemPrompts: ["Be brief."],
      messages: [{ role: "user", content: "Weather in Tokyo?" }],
      tools: weatherTools,
      ...extra
    })
  )

test("a tool step is two guided requests, as with the Prompt API: the decision, then the tool's arguments", async () => {
  stepServer({
    decision: { action: "get_weather" },
    get_weather: { city: "Tokyo" }
  })
  const chunks = await weatherRun({ modelOptions: { maxCompletionTokens: 50 } })
  assert.equal(server.requests.length, 2)
  const [decision, args] = server.requests.map((r) => r.body)
  for (const body of [decision, args]) {
    assert.equal(body.stream, undefined)
    assert.equal("tools" in body, false)
    assert.equal("max_tokens" in body, false, "the cap is the answer's")
    // The tools listed after the caller's instructions, in the Prompt API
    // adapter's words, and no instructions of the step's own.
    assert.deepEqual(body.messages, [
      { role: "system", content: `Be brief.\n\n${TOOL_LIST}` },
      { role: "user", content: "Weather in Tokyo?" }
    ])
  }
  assert.equal(formatOf(decision).json_schema.name, "decision")
  assert.deepEqual(
    formatOf(decision).json_schema.schema.properties.action.enum,
    ["answer", "get_weather", "get_current_location"]
  )
  assert.equal(formatOf(args).json_schema.name, "get_weather")
  assert.deepEqual(Object.keys(formatOf(args).json_schema.schema.properties), [
    "city",
    "days"
  ])

  assert.deepEqual(
    typesOf(chunks).filter((t) => t.startsWith("TOOL_CALL_")),
    ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]
  )
  const end = chunks.find((c) => c.type === "TOOL_CALL_END")
  assert.equal(end?.toolCallName, "get_weather")
  assert.deepEqual(end?.input, { city: "Tokyo" })
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
  const usage = chunks.at(-1)?.usage as { completionTokens: number }
  assert.equal(usage.completionTokens, 10, "both requests count")
})

test("optional argument fields can be null in the step's schema, and nulls are left out of the call", async () => {
  stepServer({
    decision: { action: "get_weather" },
    get_weather: { city: "Kyoto", days: null }
  })
  const chunks = await weatherRun()
  const args = formatOf(server.requests[1].body).json_schema.schema
    .properties as Record<string, { type: unknown }>
  assert.equal(args.city.type, "string")
  assert.deepEqual(args.days.type, ["integer", "null"])
  assert.deepEqual(chunks.find((c) => c.type === "TOOL_CALL_END")?.input, {
    city: "Kyoto"
  })
})

test("an answer is the decision, then one streamed request that lists the tools too", async () => {
  stepServer({ decision: { action: "answer" } })
  const chunks = await weatherRun()
  assert.equal(server.requests.length, 2)
  const answer = server.requests[1].body
  assert.equal(answer.stream, true)
  assert.equal("tools" in answer, false)
  assert.equal("response_format" in answer, false)
  assert.deepEqual(answer.messages[0], {
    role: "system",
    content: `Be brief.\n\n${TOOL_LIST}`
  })
  assert.equal(
    chunks.some((c) => c.type.startsWith("TOOL_CALL")),
    false
  )
  assert.equal(
    chunks
      .filter((c) => c.type === "TEXT_MESSAGE_CONTENT")
      .map((c) => c.delta)
      .join(""),
    "Sunny in Tokyo."
  )
  assert.equal(chunks.at(-1)?.finishReason, "stop")
})

test("earlier turns' tool calls and results stay in the history, as OpenAI's tool messages", async () => {
  stepServer({ decision: { action: "answer" } })
  await weatherRun({
    messages: [
      { role: "user", content: "Weather in Tokyo?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' }
          }
        ]
      },
      { role: "tool", toolCallId: "c1", content: '{"temperature":20}' },
      { role: "assistant", content: "20 degrees in Tokyo." },
      { role: "user", content: "And tomorrow?" }
    ]
  })
  assert.deepEqual(server.requests[0].body.messages.slice(1), [
    { role: "user", content: "Weather in Tokyo?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' }
        }
      ]
    },
    { role: "tool", tool_call_id: "c1", content: '{"temperature":20}' },
    { role: "assistant", content: "20 degrees in Tokyo." },
    { role: "user", content: "And tomorrow?" }
  ])
})

test("a repeat of this turn's call answers instead, as with the Prompt API", async () => {
  stepServer({
    decision: { action: "get_weather" },
    get_weather: { city: "Tokyo" }
  })
  const chunks = await weatherRun({
    messages: [
      { role: "user", content: "Weather in Tokyo?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' }
          }
        ]
      },
      { role: "tool", toolCallId: "c1", content: '{"temperature":20}' }
    ]
  })
  assert.equal(
    chunks.some((c) => c.type.startsWith("TOOL_CALL")),
    false
  )
  assert.equal(
    server.requests.length,
    3,
    "decision, arguments, then the answer"
  )
  assert.equal(server.requests[2].body.stream, true)
})

test("a repeat with its fields in another order is still a repeat", async () => {
  stepServer({
    decision: { action: "get_weather" },
    get_weather: { days: 3, city: "Tokyo" }
  })
  const chunks = await weatherRun({
    messages: [
      { role: "user", content: "Weather in Tokyo for 3 days?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Tokyo","days":3}'
            }
          }
        ]
      },
      { role: "tool", toolCallId: "c1", content: '{"temperature":20}' }
    ]
  })
  assert.equal(
    chunks.some((c) => c.type.startsWith("TOOL_CALL")),
    false
  )
  assert.equal(server.requests.at(-1)?.body.stream, true, "it answers")
})

test("toolChoice: required leaves answering out, a tool without arguments needs no second request, none sends no step, and an invalid parallelToolCalls throws first", async () => {
  stepServer({ decision: { action: "get_current_location" } })
  const chunks = await weatherRun({ toolChoice: "required" })
  assert.equal(server.requests.length, 1)
  assert.deepEqual(
    formatOf(server.requests[0].body).json_schema.schema.properties.action.enum,
    ["get_weather", "get_current_location"]
  )
  assert.deepEqual(chunks.find((c) => c.type === "TOOL_CALL_END")?.input, {})

  // A named tool skips the decision.
  server.requests = []
  stepServer({ get_weather: { city: "Oslo" } })
  const named = await weatherRun({
    toolChoice: { type: "tool", name: "get_weather" }
  })
  assert.equal(server.requests.length, 1)
  assert.equal(
    formatOf(server.requests[0].body).json_schema.name,
    "get_weather"
  )
  assert.deepEqual(named.find((c) => c.type === "TOOL_CALL_END")?.input, {
    city: "Oslo"
  })

  server.requests = []
  await weatherRun({ toolChoice: "none" })
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].body.stream, true)

  server.requests = []
  await assert.rejects(
    weatherRun({
      modelOptions: { parallelToolCalls: 0 as unknown as boolean }
    }),
    /parallelToolCalls must be a boolean/
  )
  assert.equal(server.requests.length, 0)
})

test("a conversation too long for Apple's window loses its oldest turns, as with the Prompt API", async () => {
  stepServer({ decision: { action: "answer" } })
  const long = "x".repeat(30000)
  await weatherRun({
    messages: [
      { role: "user", content: `First question ${long}` },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer." },
      { role: "user", content: "Third question" }
    ]
  })
  // The estimate leaves the first turn out before sending.
  assert.deepEqual(
    server.requests[0].body.messages.map((m) => m.content),
    [
      `Be brief.\n\n${TOOL_LIST}`,
      "Second question",
      "Second answer.",
      "Third question"
    ]
  )
})

test("an overflow apfel still reports leaves out one more turn and sends again", async () => {
  let overflowed = false
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as Body
    server.requests.push({ body, init })
    if (!overflowed) {
      overflowed = true
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Input exceeds the model's context window. Shorten the conversation history."
          }
        }),
        { status: 400 }
      )
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"action":"answer"}' } }]
      })
    )
  }
  await weatherRun({
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second question" }
    ],
    tools: [weatherTools[1]]
  }).catch(() => undefined)
  assert.equal(server.requests.length >= 2, true)
  assert.deepEqual(
    server.requests[1].body.messages.map((m) => m.content),
    [
      "Be brief.\n\nYou can use these tools:\n- get_current_location: Where the user is\nUse a tool when the user asks for one or the answer needs current or outside information; otherwise answer directly. Once you have a tool's result, answer from it.",
      "Second question"
    ]
  )
})

test("parallelToolCalls isn't sent without tools", async () => {
  await collect(
    adapter().chatStream({
      model: "apple-foundationmodel",
      logger,
      threadId: "thread",
      messages: [{ role: "user", content: "Hi" }],
      modelOptions: { parallelToolCalls: false }
    })
  )
  assert.equal("parallel_tool_calls" in (server.requests[0]?.body ?? {}), false)
  await adapter().structuredOutput(
    options({ modelOptions: { parallelToolCalls: false } })
  )
  assert.equal("parallel_tool_calls" in (server.requests[1]?.body ?? {}), false)
})
