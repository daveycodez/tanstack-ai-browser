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

const sse = (chunks: Array<unknown>, before: (index: number) => void = noop) => {
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
    const draft = body.messages.at(-1)?.content.includes("Write short working notes")
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
            { message: { content: server.answer.join("") }, finish_reason: server.finish }
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
              finish_reason: i === server.answer.length - 1 ? server.finish : null
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
  chunks.map((c) =>
    c.type === "CUSTOM" ? `CUSTOM:${String(c.name)}` : c.type
  )

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
        modelOptions: { maxCompletionTokens: 64, temperature: 0.2, topP: 0.9, seed: 7 }
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
      completionTokens: (finished?.usage as { completionTokens: number }).completionTokens
    },
    { promptTokens: 30, completionTokens: 5 }
  )
  for (const chunk of chunks) {
    assert.equal(typeof chunk.timestamp, "number")
    assert.deepEqual(
      (chunk.metadata as { tanstack: { source: unknown } }).tanstack.source,
      { provider: "apfel", api: "openai-completions", model: "apple-foundationmodel" }
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
  assert.match(server.requests[1].body.messages[0].content, /think first/)
  const complete = chunks.find((c) => c.type === "CUSTOM")
  assert.equal((complete?.value as { reasoning: string }).reasoning, "think first")
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

test("parallelToolCalls goes to apfel with tools, and false keeps one tool call", async () => {
  const tools = [
    {
      name: "get_weather",
      description: "Weather for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
    }
  ]
  const call = (index: number, city: string) => ({
    index,
    id: `call_${index + 1}`,
    type: "function",
    function: { name: "get_weather", arguments: JSON.stringify({ city }) }
  })
  /** The model's reply: two calls streamed, or as JSON text apfel didn't recognize. */
  let reply: "streamed" | "text" = "streamed"
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as Body
    server.requests.push({ body, init })
    // Argument repair fails, so the model's own arguments stand.
    if (!body.stream) return new Response("{}", { status: 500 })
    return sse(
      reply === "streamed"
        ? [
            { choices: [{ delta: { tool_calls: [call(0, "Tokyo")] } }] },
            { choices: [{ delta: { tool_calls: [call(1, "Paris")] }, finish_reason: "tool_calls" }] }
          ]
        : [
            {
              choices: [
                {
                  delta: {
                    content:
                      '{"tool_calls": [{"function": "get_weather", "arguments": {"city": "Tokyo"}}, {"function": "get_weather", "arguments": {"city": "Paris"}}]}'
                  },
                  finish_reason: "stop"
                }
              ]
            }
          ]
    )
  }
  const run = (modelOptions: ApfelTextModelOptions) =>
    collect(
      adapter().chatStream({
        model: "apple-foundationmodel",
        logger,
        threadId: "thread",
        messages: [{ role: "user", content: "Weather in Tokyo and Paris?" }],
        tools,
        modelOptions
      })
    )
  const toolEvents = (chunks: Array<Chunk>) => typesOf(chunks).filter((t) => t.startsWith("TOOL_CALL_"))
  const cities = (chunks: Array<Chunk>) =>
    chunks.filter((c) => c.type === "TOOL_CALL_END").map((c) => (c.input as { city: string }).city)

  const single = await run({ parallelToolCalls: false })
  assert.equal(server.requests[0]?.body.parallel_tool_calls, false)
  assert.deepEqual(toolEvents(single), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"])
  assert.deepEqual(cities(single), ["Tokyo"])
  assert.equal(single.at(-1)?.finishReason, "tool_calls")
  assert.equal(server.requests.length, 2, "only the kept call's arguments are repaired")

  for (const [modelOptions, sent] of [[{ parallelToolCalls: true }, true], [{}, undefined]] as const) {
    server.requests = []
    const chunks = await run(modelOptions)
    assert.equal(server.requests[0]?.body.parallel_tool_calls, sent)
    assert.equal("parallel_tool_calls" in (server.requests[0]?.body ?? {}), sent !== undefined)
    assert.deepEqual(cities(chunks), ["Tokyo", "Paris"])
  }

  reply = "text"
  server.requests = []
  assert.deepEqual(cities(await run({ parallelToolCalls: false })), ["Tokyo"], "calls read from the text too")
  assert.deepEqual(cities(await run({})), ["Tokyo", "Paris"])

  server.requests = []
  await assert.rejects(
    run({ parallelToolCalls: 0 as unknown as boolean }),
    /parallelToolCalls must be a boolean/
  )
  assert.equal(server.requests.length, 0)
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
  await adapter().structuredOutput(options({ modelOptions: { parallelToolCalls: false } }))
  assert.equal("parallel_tool_calls" in (server.requests[1]?.body ?? {}), false)
})
