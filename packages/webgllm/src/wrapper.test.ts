/**
 * What the adapter adds to TanStack's Chat Completions adapter: loading the
 * model, webgllm's option names, reasoning levels and thinking budget, the
 * history it reads, structured output's schema, and aborts.
 */
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { WebGLLM, WebGLLMError } from "webgllm"

import { webgllmText } from "./adapter.js"
import { chunk, collect, fake, lastBody, MODEL, textOptions, usageChunk } from "./fake-webgllm.test.js"
import { forgetEngineCheck } from "./models.js"

const engine = WebGLLM as unknown as { isSupported: () => boolean }
beforeEach(() => {
  fake.reset()
  engine.isSupported = () => true
  forgetEngineCheck()
})

type Event = { type: string } & Record<string, unknown>
const types = (events: Array<unknown>) => (events as Array<Event>).map((e) => e.type)

test("a call loads the model, then streams thinking, text and tool calls as AG-UI events", async () => {
  fake.script = () => [
    chunk({ role: "assistant", reasoning_content: "Let me look." }),
    chunk({ content: "Checking." }),
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }] }),
    chunk({}, "tool_calls"),
    usageChunk({ prompt: 20, completion: 7 })
  ]
  const lookup = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
  const events = (await collect(webgllmText(MODEL, { contextLength: 4096 }).chatStream(textOptions({ tools: [lookup] })))) as Array<Event>
  assert.equal(fake.loads[0]?.model, MODEL)
  assert.equal(fake.loads[0]?.options.contextLength, 4096)
  const kinds = types(events)
  for (const kind of ["RUN_STARTED", "REASONING_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TOOL_CALL_START", "TOOL_CALL_END", "RUN_FINISHED"]) {
    assert.ok(kinds.includes(kind), `${kind} in ${kinds.join(", ")}`)
  }
  assert.equal(events.find((e) => e.type === "REASONING_MESSAGE_CONTENT")?.delta, "Let me look.")
  assert.equal(events.find((e) => e.type === "TOOL_CALL_END")?.toolName ?? events.find((e) => e.type === "TOOL_CALL_END")?.toolCallName, "lookup")
  assert.equal(events.at(-1)?.finishReason, "tool_calls")
  const body = lastBody() as unknown as Record<string, unknown>
  assert.equal(body.model, MODEL)
  assert.equal(body.stream, true)
  // The schema as given, without OpenAI's strict-mode rewrite (TanStack only closes it to undeclared fields).
  assert.deepEqual((body.tools as Array<{ function: { parameters: unknown } }>)[0]?.function.parameters, {
    ...lookup.inputSchema,
    additionalProperties: false
  })
})

test("modelOptions go with webgllm's names", async () => {
  await collect(
    webgllmText(MODEL).chatStream(
      textOptions({
        modelOptions: {
          maxCompletionTokens: 64,
          temperature: 0.2,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          repetitionPenalty: 1.1,
          presencePenalty: 0.5,
          stop: ["END"],
          seed: 7,
          parallelToolCalls: false,
          repairToolCalls: false
        }
      })
    )
  )
  const body = lastBody() as unknown as Record<string, unknown>
  assert.deepEqual(
    {
      max_completion_tokens: body.max_completion_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      min_p: body.min_p,
      repetition_penalty: body.repetition_penalty,
      presence_penalty: body.presence_penalty,
      stop: body.stop,
      seed: body.seed,
      parallel_tool_calls: body.parallel_tool_calls,
      repair_tool_calls: body.repair_tool_calls
    },
    {
      max_completion_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.1,
      presence_penalty: 0.5,
      stop: ["END"],
      seed: 7,
      parallel_tool_calls: false,
      repair_tool_calls: false
    }
  )
  assert.equal(body.maxCompletionTokens, undefined)
})

test("reasoning: off and high as webgllm's reasoning_effort, a budget as thinking_budget_tokens", async () => {
  await collect(webgllmText(MODEL).chatStream(textOptions({ reasoning: { level: "off", summary: false } })))
  assert.equal((lastBody() as unknown as Record<string, unknown>).reasoning_effort, "none")
  await collect(webgllmText(MODEL).chatStream(textOptions({ reasoning: { level: "high", summary: false, budgetTokens: 256 } })))
  const body = lastBody() as unknown as Record<string, unknown>
  assert.equal(body.reasoning_effort, "high")
  assert.equal(body.thinking_budget_tokens, 256)
  // Off ignores a budget; a model that doesn't think gets neither.
  await collect(webgllmText(MODEL).chatStream(textOptions({ reasoning: { level: "off", summary: false } })))
  assert.equal((lastBody() as unknown as Record<string, unknown>).thinking_budget_tokens, undefined)
  await collect(webgllmText("LiquidAI/LFM2.5-350M-GGUF").chatStream(textOptions({ model: "LiquidAI/LFM2.5-350M-GGUF" })))
  assert.equal((lastBody() as unknown as Record<string, unknown>).reasoning_effort, undefined)
})

test("no prompt cache when asked", async () => {
  await collect(webgllmText(MODEL).chatStream(textOptions({ promptCache: { retention: "none" } } as never)))
  assert.equal((lastBody() as unknown as { cache_prompt?: boolean }).cache_prompt, false)
})

test("structured output: the schema as given in response_format, the system prompt as given, and the answer parsed", async () => {
  const schema = { type: "object", properties: { moveId: { type: "string" }, note: { type: "string" } }, required: ["moveId"] }
  fake.script = () => [chunk({ content: '{"moveId":"b6-a5"}' }), chunk({}, "stop"), usageChunk()]
  const result = await webgllmText(MODEL).structuredOutput({ chatOptions: textOptions({ systemPrompts: ["Play well."] }), outputSchema: schema })
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  const body = lastBody() as unknown as {
    messages: Array<{ role: string; content: string }>
    response_format: { json_schema: { schema: unknown } }
  }
  assert.deepEqual(body.response_format.json_schema.schema, schema)
  assert.equal(body.messages[0]!.content, "Play well.")

  const events = (await collect(
    webgllmText(MODEL).structuredOutputStream({ chatOptions: textOptions(), outputSchema: schema })
  )) as Array<Event>
  assert.ok(types(events).includes("RUN_FINISHED"))
})

test("a model that can't load rejects with webgllm's error, before any request", async () => {
  fake.loadError = new WebGLLMError("storage-full", "No room for the model.")
  await assert.rejects(collect(webgllmText(MODEL).chatStream(textOptions())), (error) => error instanceof WebGLLMError && error.code === "storage-full")
  assert.equal(fake.requests.length, 0)
})

test("the caller's signal reaches webgllm, which stops the generation", async () => {
  const controller = new AbortController()
  await collect(webgllmText(MODEL).chatStream(textOptions({ request: { signal: controller.signal } })))
  assert.equal(fake.requests[0]?.options.signal, controller.signal)
})
