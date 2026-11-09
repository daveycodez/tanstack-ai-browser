import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { chat } from "@tanstack/ai"
import type { PromptCacheOptions } from "@tanstack/ai"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"

import { webgllmText } from "./adapter.js"
import { chunk, collect, fake, lastBody, MODEL, usageChunk } from "./fake-webgllm.test.js"

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

test("structuredOutputStream: no thinking leaves reasoning out of the complete event", async () => {
  fake.script = () => [chunk({ content: '{"moveId":"b6-a5"}' }), chunk({}, "stop"), usageChunk()]
  const events = (await collect(
    webgllmText(MODEL).structuredOutputStream({ chatOptions: chatOptions(), outputSchema: schema })
  )) as Array<Event>
  assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM", "RUN_FINISHED"])
  assert.deepEqual(events[4]!.value, { object: { moveId: "b6-a5" }, raw: '{"moveId":"b6-a5"}' })
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
  // chat() passes a signal of its own, tied to the caller's controller.
  const signal = fake.requests.at(-1)!.options.signal as AbortSignal
  assert.ok(signal)
  controller.abort()
  assert.equal(signal.aborted, true)
})
