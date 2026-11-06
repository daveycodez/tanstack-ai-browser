import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { chat } from "@tanstack/ai"
import type { PromptCacheOptions } from "@tanstack/ai"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import { WebGLLMError } from "webgllm"

import { webgllmText } from "./adapter.js"
import { chunk, collect, fake, lastBody, MODEL, TIMINGS, usageChunk } from "./fake-webgllm.test.js"

beforeEach(() => fake.reset())

const schema = {
  type: "object",
  properties: { moveId: { type: "string", enum: ["b6-a5"] } },
  required: ["moveId"],
  additionalProperties: false
}

const chatOptions = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  threadId: "schema-forwarding",
  logger: resolveDebugOption(false),
  messages: [{ role: "user" as const, content: "Choose" }],
  ...extra
})

test("structured output sends the schema as response_format and parses the answer", async () => {
  fake.script = () => [
    chunk({ reasoning_content: "Analyze " }),
    chunk({ reasoning_content: "a capture." }),
    chunk({ content: '{"move' }),
    chunk({ content: 'Id":"b6-a5"}' }),
    chunk({}, "stop"),
    usageChunk({ prompt: 30, completion: 12 })
  ]
  const adapter = webgllmText(MODEL)
  const result = await adapter.structuredOutput({
    chatOptions: chatOptions({
      systemPrompts: ["Original caller instructions"],
      modelOptions: { maxCompletionTokens: 8192 },
      reasoning: { level: "high", summary: true, budgetTokens: 512 }
    }),
    outputSchema: schema
  })
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  assert.equal(result.rawText, '{"moveId":"b6-a5"}')
  assert.equal(result.usage?.promptTokens, 30)
  assert.equal(result.usage?.completionTokens, 12)
  const body = lastBody()
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "output", schema } })
  assert.equal(body.max_completion_tokens, 8192)
  assert.equal(body.thinking_budget_tokens, 512)
  assert.equal("tools" in body, false)
  assert.deepEqual(body.messages, [
    {
      role: "system",
      content: `Original caller instructions\n\nAnswer with only a JSON value matching this JSON Schema:\n${JSON.stringify(schema)}`
    },
    { role: "user", content: "Choose" }
  ])
})

test("structured output failures reject: webgllm's errors as they are, and an answer that isn't JSON", async () => {
  const adapter = webgllmText(MODEL)
  fake.script = () => [new WebGLLMError("invalid-output", "No token can complete the requested output schema.")]
  await assert.rejects(
    adapter.structuredOutput({ chatOptions: chatOptions(), outputSchema: schema }),
    (error: unknown) => error instanceof WebGLLMError && error.code === "invalid-output"
  )
  fake.script = () => [chunk({ content: "Paris" }), chunk({}, "stop")]
  await assert.rejects(adapter.structuredOutput({ chatOptions: chatOptions(), outputSchema: schema }), /isn't JSON/)
  assert.equal(fake.requests.length, 2, "never retried")

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    adapter.structuredOutput({ chatOptions: chatOptions({ abortController: controller }), outputSchema: schema }),
    (error: unknown) => (error as Error).name === "AbortError"
  )
  assert.equal(fake.requests.length, 2)
})

test("chat({ outputSchema }) returns the parsed object", async () => {
  fake.script = () => [chunk({ content: '{"moveId":"b6-a5"}' }), chunk({}, "stop"), usageChunk()]
  const result = await chat({
    adapter: webgllmText(MODEL),
    threadId: "structured",
    messages: [{ role: "user", content: "Choose a move." }],
    outputSchema: schema,
    stream: false
  })
  assert.deepEqual(result, { moveId: "b6-a5" })
  assert.ok(lastBody().response_format)
})

test("promptCache none sends cache_prompt: false in streaming chat and structured output, and nothing otherwise", async () => {
  const cases: Array<{ option?: PromptCacheOptions; none: boolean }> = [
    { none: false },
    { option: "none", none: true },
    { option: "short", none: false },
    { option: "long", none: false },
    { option: { retention: "long", key: "explicit-cache-key" }, none: false },
    { option: { retention: "none", key: "none-key" }, none: true }
  ]
  for (const entry of cases) {
    for (const structured of [false, true]) {
      fake.script = () => [chunk({ content: structured ? '{"moveId":"b6-a5"}' : "ok" }), chunk({}, "stop"), usageChunk()]
      await chat({
        adapter: webgllmText(MODEL),
        threadId: "public-cache",
        messages: [{ role: "user", content: "Choose a move." }],
        ...(entry.option !== undefined && { promptCache: entry.option }),
        ...(structured && { outputSchema: schema }),
        stream: false
      })
      const body = lastBody()
      assert.equal("cache_prompt" in body, entry.none, JSON.stringify(entry))
      if (entry.none) assert.equal(body.cache_prompt, false)
      assert.ok(!JSON.stringify(body.messages).includes("cache-key"), "a cache key is never rendered into the prompt")
      assert.equal(body.response_format !== undefined, structured)
    }
  }
})

type Event = { type: string } & Record<string, unknown>
const types = (events: Array<Event>) => events.map((e) => e.type)

test("structuredOutputStream: thinking, raw JSON deltas, the complete event, then RUN_FINISHED with usage", async () => {
  fake.script = () => [
    chunk({ role: "assistant", reasoning_content: "Analyze " }),
    chunk({ reasoning_content: "a capture." }),
    chunk({ content: '{"move' }),
    chunk({ content: 'Id":"b6-a5"}' }),
    chunk({}, "stop"),
    usageChunk({ prompt: 30, completion: 12, reasoning: 5 })
  ]
  const events = (await collect(
    webgllmText(MODEL).structuredOutputStream({
      chatOptions: chatOptions({ runId: "structured-run", modelOptions: { maxCompletionTokens: 512 } }),
      outputSchema: schema
    })
  )) as Array<Event>
  assert.deepEqual(types(events), [
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
    "CUSTOM",
    "RUN_FINISHED"
  ])
  assert.deepEqual(events.filter((e) => e.type === "REASONING_MESSAGE_CONTENT").map((e) => e.delta), ["Analyze ", "a capture."])
  assert.deepEqual(
    events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => [e.delta, e.content]),
    [['{"move', '{"move'], ['Id":"b6-a5"}', '{"moveId":"b6-a5"}']]
  )
  const complete = events.find((e) => e.type === "CUSTOM")!
  assert.equal(complete.name, "structured-output.complete")
  assert.deepEqual(complete.value, { object: { moveId: "b6-a5" }, raw: '{"moveId":"b6-a5"}', reasoning: "Analyze a capture." })
  const finished = events.at(-1)!
  assert.equal(finished.runId, "structured-run")
  assert.equal(events[0]!.runId, "structured-run")
  assert.equal(finished.finishReason, "stop")
  assert.deepEqual(finished.usage, {
    promptTokens: 30,
    completionTokens: 12,
    totalTokens: 42,
    completionTokensDetails: { reasoningTokens: 5 },
    providerUsageDetails: {
      firstTokenMs: TIMINGS.first_token_ms,
      promptMs: TIMINGS.prompt_ms,
      decodeMs: TIMINGS.decode_ms,
      promptTokensPerSecond: TIMINGS.prompt_tokens_per_second,
      decodeTokensPerSecond: TIMINGS.decode_tokens_per_second
    }
  })
  const timestamps = events.map((e) => e.timestamp as number)
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b), "timestamps follow stream order")
  assert.equal(fake.requests.length, 1, "one request")
  assert.deepEqual(lastBody().response_format, { type: "json_schema", json_schema: { name: "output", schema } })
  assert.equal(lastBody().max_completion_tokens, 512)
})

test("structuredOutputStream: no thinking leaves reasoning out of the complete event", async () => {
  fake.script = () => [chunk({ content: '{"moveId":"b6-a5"}' }), chunk({}, "stop"), usageChunk()]
  const events = (await collect(
    webgllmText(MODEL).structuredOutputStream({ chatOptions: chatOptions(), outputSchema: schema })
  )) as Array<Event>
  assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM", "RUN_FINISHED"])
  assert.deepEqual(events[4]!.value, { object: { moveId: "b6-a5" }, raw: '{"moveId":"b6-a5"}' })
})

test("structuredOutputStream failures are RUN_ERRORs: webgllm's code, a failed load, an answer that isn't JSON, a cut-off answer", async () => {
  const adapter = webgllmText(MODEL)
  const run = async () =>
    (await collect(adapter.structuredOutputStream({ chatOptions: chatOptions(), outputSchema: schema }))) as Array<Event>

  fake.script = () => [chunk({ content: '{"mo' }), new WebGLLMError("invalid-output", "No token can complete the requested output schema.")]
  let events = await run()
  assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_ERROR"])
  assert.equal(events.at(-1)!.code, "invalid-output")
  assert.equal(events.at(-1)!.message, "No token can complete the requested output schema.")

  fake.script = () => [chunk({ content: "Paris" }), chunk({}, "stop"), usageChunk()]
  events = await run()
  assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_ERROR"])
  assert.equal(events.at(-1)!.code, "structured-output-parse-failed")
  assert.match(events.at(-1)!.message as string, /isn't JSON: Paris/)

  fake.script = () => [chunk({ content: '{"moveId":"b6' }), chunk({}, "length"), usageChunk()]
  events = await run()
  assert.equal(events.at(-1)!.type, "RUN_ERROR")
  assert.equal(events.at(-1)!.code, "max_tokens")

  fake.reset()
  fake.loadError = new WebGLLMError("download-failed", "Network down.")
  events = await run()
  assert.deepEqual(types(events), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(events[1]!.message, `Couldn't load ${MODEL}: Network down.`)
  assert.equal(events[1]!.code, "download-failed")
})

test("structuredOutputStream: an abort closes open messages and ends with neither the complete event nor RUN_ERROR", async () => {
  const controller = new AbortController()
  let release!: () => void
  const paused = new Promise<void>((resolve) => (release = resolve))
  fake.script = () => [chunk({ reasoning_content: "hmm" }), { wait: paused }, chunk({ content: '{"moveId":"b6-a5"}' }), chunk({}, "stop")]
  const events: Array<Event> = []
  for await (const event of webgllmText(MODEL).structuredOutputStream({
    chatOptions: chatOptions({ request: { signal: controller.signal } }),
    outputSchema: schema
  })) {
    events.push(event as Event)
    if ((event as Event).type === "REASONING_MESSAGE_CONTENT") {
      controller.abort()
      release()
    }
  }
  assert.deepEqual(types(events), ["RUN_STARTED", "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "REASONING_END"])
  assert.equal(fake.requests[0]!.options.signal, controller.signal)

  const before = new AbortController()
  before.abort()
  assert.deepEqual(
    await collect(webgllmText(MODEL).structuredOutputStream({ chatOptions: chatOptions({ abortController: before }), outputSchema: schema })),
    []
  )
  assert.equal(fake.requests.length, 1)
})

test("chat({ outputSchema, stream: true }) streams thinking, JSON deltas and the typed complete event", async () => {
  fake.script = () => [
    chunk({ reasoning_content: "Capture." }),
    chunk({ content: '{"moveId":' }),
    chunk({ content: '"b6-a5"}' }),
    chunk({}, "stop"),
    usageChunk()
  ]
  const stream = chat({
    adapter: webgllmText(MODEL),
    threadId: "structured-stream",
    messages: [{ role: "user", content: "Choose a move." }],
    outputSchema: schema,
    stream: true
  })
  const events: Array<Event> = []
  let object: unknown
  for await (const event of stream) {
    events.push(event as unknown as Event)
    if (event.type === "CUSTOM" && event.name === "structured-output.complete") object = event.value.object
  }
  assert.deepEqual(object, { moveId: "b6-a5" })
  const seen = types(events)
  for (const type of ["RUN_STARTED", "REASONING_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "CUSTOM", "RUN_FINISHED"]) {
    assert.ok(seen.includes(type), `${type} in ${seen.join(", ")}`)
  }
  assert.ok(seen.indexOf("REASONING_MESSAGE_CONTENT") < seen.indexOf("TEXT_MESSAGE_CONTENT"))
  assert.deepEqual(
    events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta),
    ['{"moveId":', '"b6-a5"}']
  )
  assert.equal(fake.requests.length, 1, "one streamed request, no separate structuredOutput call")
})

test("chat({ outputSchema, abortController }) forwards the signal to webgllm through structuredOutputStream", async () => {
  fake.script = () => [chunk({ content: '{"moveId":"b6-a5"}' }), chunk({}, "stop"), usageChunk()]
  const controller = new AbortController()
  const result = await chat({
    adapter: webgllmText(MODEL),
    threadId: "structured-signal",
    messages: [{ role: "user", content: "Choose a move." }],
    outputSchema: schema,
    abortController: controller,
    stream: false
  })
  assert.deepEqual(result, { moveId: "b6-a5" })
  assert.equal(fake.requests.at(-1)!.options.signal, controller.signal)
})
