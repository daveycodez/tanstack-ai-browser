import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { chat } from "@tanstack/ai"
import type { PromptCacheOptions } from "@tanstack/ai"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import { WebGLLMError } from "webgllm"

import { webgllmText } from "./adapter.js"
import { chunk, fake, lastBody, MODEL, usageChunk } from "./fake-webgllm.test.js"

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
  const thinking: Array<string> = []
  const phases: Array<string> = []
  const adapter = webgllmText(MODEL, { onThinking: (d) => thinking.push(d), onGenerationPhase: (p) => phases.push(p) })
  const result = await adapter.structuredOutput({
    chatOptions: chatOptions({
      systemPrompts: ["Original caller instructions"],
      modelOptions: { maxTokens: 8192 },
      reasoning: { level: "high", summary: true, budgetTokens: 512 }
    }),
    outputSchema: schema
  })
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  assert.equal(result.rawText, '{"moveId":"b6-a5"}')
  assert.equal(result.usage?.promptTokens, 30)
  assert.equal(result.usage?.completionTokens, 12)
  assert.deepEqual(thinking, ["Analyze ", "a capture."])
  assert.deepEqual(phases, ["processing", "generating"])
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
