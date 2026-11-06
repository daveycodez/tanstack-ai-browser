import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { chat } from "@tanstack/ai"
import type { TextOptions } from "@tanstack/ai"

import { promptApiText } from "./adapter.js"
import type { PromptApiTextConfig } from "./adapter.js"
import { destroyPromptApiSessions } from "./sessions.js"

type Chunk = { type: string; [key: string]: unknown }
type Call = { kind: string; input: unknown; options: Record<string, unknown> }

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

/** What the fake browser model does, per test. */
const control = {
  calls: [] as Array<Call>,
  /** The answer (constrained or not), streamed in these pieces. */
  answer: ['{"moveId":', '"b6-a5"}'] as Array<unknown>,
  /** Texts measured with measureContextUsage, in order. */
  measured: [] as Array<string>,
  /** The working notes a reasoning draft streams. */
  notes: ["think ", "first"],
  /** Thrown by the constrained prompt instead of answering. */
  failure: undefined as unknown,
  /** Called before each streamed answer piece. */
  beforePiece: noop as (index: number) => void,
  destroyed: 0
}

const textOf = (input: unknown): string =>
  typeof input === "string"
    ? input
    : Array.isArray(input)
      ? input.map(textOf).join("")
      : input && typeof input === "object"
        ? textOf((input as { content?: unknown }).content ?? "")
        : ""

class FakeSession extends EventTarget {
  contextUsage = 40
  readonly contextWindow = 9216
  async clone() {
    return new FakeSession()
  }
  destroy() {
    control.destroyed++
  }
  async append(input: unknown) {
    this.contextUsage += textOf(input).length
  }
  async measureContextUsage(input: unknown) {
    control.measured.push(textOf(input))
    return textOf(input).length
  }
  async prompt(input: unknown, options: Record<string, unknown> = {}) {
    control.calls.push({ kind: "prompt", input, options })
    if (control.failure) throw control.failure
    return control.answer.map(textOf).join("")
  }
  promptStreaming(input: unknown, options: Record<string, unknown> = {}) {
    const draft = textOf(input).includes("Write short working notes")
    control.calls.push({ kind: draft ? "draft" : "stream", input, options })
    const signal = options.signal as AbortSignal | undefined
    const pieces = draft ? control.notes : control.answer
    let index = 0
    return new ReadableStream<unknown>(
      {
        pull(controller) {
          if (!draft && control.failure) {
            controller.error(control.failure)
            return
          }
          if (!draft) control.beforePiece(index)
          if (signal?.aborted) {
            controller.error(signal.reason)
            return
          }
          if (index >= pieces.length) {
            controller.close()
            return
          }
          controller.enqueue(pieces[index++])
        }
      },
      { highWaterMark: 0 }
    )
  }
}

;(globalThis as { LanguageModel?: unknown }).LanguageModel = {
  availability: async () => "available",
  create: async () => new FakeSession()
}

beforeEach(() => {
  destroyPromptApiSessions()
  control.calls = []
  control.answer = ['{"moveId":', '"b6-a5"}']
  control.measured = []
  control.notes = ["think ", "first"]
  control.failure = undefined
  control.beforePiece = noop
  control.destroyed = 0
})

const options = (extra: Record<string, unknown> = {}) => ({
  chatOptions: {
    model: "built-in",
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

test("the config has no custom callbacks for reasoning or phases", () => {
  // @ts-expect-error onThinking was removed: reasoning streams as REASONING_* events.
  const thinking: PromptApiTextConfig = { onThinking: noop }
  // @ts-expect-error onGenerationPhase was removed.
  const phases: PromptApiTextConfig = { onGenerationPhase: noop }
  assert.ok(thinking && phases)
})

test("structuredOutputStream streams the constrained JSON as text deltas, then the complete event and usage", async () => {
  const adapter = promptApiText()
  const chunks = await collect(
    adapter.structuredOutputStream(options({ runId: "run-1" }))
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
  const stream = control.calls.find((c) => c.kind === "stream")
  assert.ok(stream, "the answer comes from promptStreaming")
  assert.deepEqual(stream.options.responseConstraint, schema)
  const deltas = chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT")
  assert.deepEqual(deltas.map((c) => c.delta), ['{"moveId":', '"b6-a5"}'])
  const messageIds = new Set(
    chunks.filter((c) => c.type.startsWith("TEXT_MESSAGE")).map((c) => c.messageId)
  )
  assert.equal(messageIds.size, 1)
  const complete = chunks.find((c) => c.type === "CUSTOM")
  assert.deepEqual(complete?.value, {
    object: { moveId: "b6-a5" },
    raw: '{"moveId":"b6-a5"}'
  })
  const finished = chunks.at(-1)
  assert.equal(finished?.runId, "run-1")
  assert.equal(chunks[0].runId, "run-1")
  assert.equal(finished?.finishReason, "stop")
  const usage = finished?.usage as {
    promptTokens: number
    completionTokens: number
    providerUsageDetails: { contextWindow: number }
  }
  assert.equal(usage.completionTokens, '{"moveId":"b6-a5"}'.length)
  assert.equal(usage.providerUsageDetails.contextWindow, 9216)
  for (const chunk of chunks) {
    assert.equal(typeof chunk.timestamp, "number")
    assert.deepEqual(
      (chunk.metadata as { tanstack: { source: unknown } }).tanstack.source,
      { provider: "prompt-api", api: "prompt-api", model: "built-in" }
    )
  }
  const stamps = chunks.map((c) => c.timestamp as number)
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b))
  assert.ok(control.destroyed > 0, "the disposable clone is freed")
})

test("emulated reasoning streams as REASONING_* events before the JSON, and rides on the complete event", async () => {
  const chunks = await collect(
    promptApiText().structuredOutputStream(
      options({ reasoning: { level: "high" } })
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
  assert.deepEqual(
    chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta),
    ["think ", "first"]
  )
  const complete = chunks.find((c) => c.type === "CUSTOM")
  assert.equal((complete?.value as { reasoning: string }).reasoning, "think first")
  const stream = control.calls.find((c) => c.kind === "stream")
  assert.match(textOf(stream?.input), /think first/)
  const details = (chunks.at(-1)?.usage as { providerUsageDetails: Record<string, unknown> })
    .providerUsageDetails
  assert.equal(details.reasoningEmulated, true)
  assert.equal(details.thinkingTokens, "think first".length)
})

test("an answer that isn't JSON ends with RUN_ERROR parse-error, after its text", async () => {
  control.answer = ["not json"]
  const chunks = await collect(promptApiText().structuredOutputStream(options()))
  assert.deepEqual(typesOf(chunks), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_ERROR"
  ])
  assert.equal(chunks.at(-1)?.code, "parse-error")
  assert.match(String(chunks.at(-1)?.message), /isn't JSON/)
})

test("a schema the browser can't enforce ends with RUN_ERROR unsupported-schema", async () => {
  control.failure = new DOMException("no", "NotSupportedError")
  const chunks = await collect(promptApiText().structuredOutputStream(options()))
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(chunks[1].code, "unsupported-schema")
  assert.match(String(chunks[1].message), /cannot enforce/)
})

test("an abort mid-answer ends with RUN_ERROR aborted and frees the session", async () => {
  const controller = new AbortController()
  control.beforePiece = (index) => {
    if (index === 1) controller.abort(new Error("stop now"))
  }
  const chunks = await collect(
    promptApiText().structuredOutputStream(
      options({ request: { signal: controller.signal } })
    )
  )
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.equal(chunks.at(-1)?.code, "aborted")
  assert.equal(chunks.at(-1)?.message, "stop now")
  assert.ok(!chunks.some((c) => c.type === "RUN_FINISHED"))
  assert.ok(control.destroyed > 0)
})

test("structuredOutput still answers with one constrained prompt", async () => {
  const result = await promptApiText().structuredOutput(options())
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  assert.equal(result.rawText, '{"moveId":"b6-a5"}')
  assert.ok(result.usage)
  assert.deepEqual(control.calls.map((c) => c.kind), ["prompt"])
  assert.equal("reasoning" in result, false)
})

test("chat({ outputSchema, stream: true }) runs end to end on the adapter's stream", async () => {
  const stream = chat({
    adapter: promptApiText(),
    threadId: "chat-thread",
    messages: [{ role: "user", content: "Choose a move" }],
    outputSchema: schema,
    stream: true
  })
  const chunks = await collect(stream)
  const complete = chunks.find(
    (c) => c.type === "CUSTOM" && c.name === "structured-output.complete"
  )
  assert.deepEqual((complete?.value as { object: unknown }).object, {
    moveId: "b6-a5"
  })
  assert.ok(chunks.some((c) => c.type === "TEXT_MESSAGE_CONTENT"))
  assert.equal(chunks.at(-1)?.type, "RUN_FINISHED")
  assert.ok(control.calls.some((c) => c.kind === "stream"))

  const value = await chat({
    adapter: promptApiText(),
    threadId: "chat-thread-2",
    messages: [{ role: "user", content: "Choose a move" }],
    outputSchema: schema
  })
  assert.deepEqual(value, { moveId: "b6-a5" })
})

// maxCompletionTokens, emulated: the fake tokenizer counts one token per character.

const chatOptions = (extra: Record<string, unknown> = {}) =>
  ({
    model: "built-in",
    logger,
    threadId: "chat-thread",
    messages: [{ role: "user" as const, content: "Say hello" }],
    ...extra
  }) as unknown as TextOptions

type Details = Record<string, unknown>
const detailsOf = (chunk: Chunk | undefined) =>
  (chunk?.usage as { providerUsageDetails: Details }).providerUsageDetails
const textIn = (chunks: Array<Chunk>) =>
  chunks.filter((c) => c.type === "TEXT_MESSAGE_CONTENT").map((c) => c.delta).join("")
const streamSignals = () =>
  control.calls
    .filter((c) => c.kind === "stream")
    .map((c) => c.options.signal as AbortSignal)

test("chatStream stops at maxCompletionTokens with finishReason length, by an internal abort only", async () => {
  control.answer = ["Hello ", "there, ", "world!"]
  const controller = new AbortController()
  const chunks = await collect(
    promptApiText().chatStream(
      chatOptions({
        modelOptions: { maxCompletionTokens: 8 },
        abortController: controller
      })
    )
  )
  assert.equal(textIn(chunks), "Hello th")
  const finished = chunks.at(-1)
  assert.equal(finished?.type, "RUN_FINISHED")
  assert.equal(finished?.finishReason, "length")
  assert.equal(controller.signal.aborted, false, "the caller's signal is never aborted")
  const [signal] = streamSignals()
  assert.notEqual(signal, controller.signal)
  assert.equal(signal.aborted, true, "the cap aborts the generation")
  const details = detailsOf(finished)
  assert.equal(details.outputTokenLimit, 8)
  assert.equal(details.outputTokenLimitReached, true)
  assert.equal(details.outputTokenLimitEnforcement, "best-effort")
  assert.equal(details.outputTokenMeasurement, "context-usage")
  assert.equal((finished?.usage as { completionTokens: number }).completionTokens, 8)
  // Text under the cap ("Hello ") was never measured; the rest was searched.
  assert.ok(!control.measured.includes("Hello "))
  assert.ok(control.measured.length < 10, `measured ${control.measured.length} times`)
})

test("chatStream under maxCompletionTokens never measures mid-stream and finishes with stop", async () => {
  control.answer = ["Hello ", "there, ", "world!"]
  const chunks = await collect(
    promptApiText().chatStream(chatOptions({ modelOptions: { maxCompletionTokens: 100 } }))
  )
  assert.equal(textIn(chunks), "Hello there, world!")
  assert.equal(chunks.at(-1)?.finishReason, "stop")
  assert.equal(detailsOf(chunks.at(-1)).outputTokenLimitReached, false)
  // Only the finished reply is measured, for usage, as without a cap.
  assert.deepEqual(control.measured, ["Hello there, world!"])
})

test("chatStream without maxCompletionTokens passes the caller's signal and reports no cap", async () => {
  control.answer = ["Hello"]
  const controller = new AbortController()
  const chunks = await collect(
    promptApiText().chatStream(chatOptions({ abortController: controller }))
  )
  assert.equal(streamSignals()[0], controller.signal)
  assert.equal("outputTokenLimit" in detailsOf(chunks.at(-1)), false)
})

test("invalid maxCompletionTokens and parallelToolCalls throw before any session work", async () => {
  for (const maxCompletionTokens of [-1, 1.5, Number.NaN, Infinity, "5"]) {
    await assert.rejects(
      promptApiText().structuredOutput(options({ modelOptions: { maxCompletionTokens } })),
      /maxCompletionTokens must be a nonnegative safe integer/
    )
    await assert.rejects(
      collect(promptApiText().chatStream(chatOptions({ modelOptions: { maxCompletionTokens } }))),
      /maxCompletionTokens must be a nonnegative safe integer/
    )
  }
  await assert.rejects(
    collect(promptApiText().chatStream(chatOptions({ modelOptions: { parallelToolCalls: "no" } }))),
    /parallelToolCalls must be a boolean/
  )
  assert.equal(control.calls.length, 0)
})

test("maxCompletionTokens 0 writes nothing and finishes with length", async () => {
  const chunks = await collect(
    promptApiText().chatStream(chatOptions({ modelOptions: { maxCompletionTokens: 0 } }))
  )
  assert.deepEqual(typesOf(chunks), ["RUN_STARTED", "RUN_FINISHED"])
  assert.equal(chunks.at(-1)?.finishReason, "length")
  assert.equal(control.calls.length, 0)
})

test("structured output cut off by maxCompletionTokens fails with RUN_ERROR max_tokens", async () => {
  const chunks = await collect(
    promptApiText().structuredOutputStream(
      options({ modelOptions: { maxCompletionTokens: 12 } })
    )
  )
  assert.equal(textIn(chunks), '{"moveId":"b')
  const error = chunks.at(-1)
  assert.equal(error?.type, "RUN_ERROR")
  assert.equal(error?.code, "max_tokens")
  assert.match(String(error?.message), /raise maxCompletionTokens/)
  await assert.rejects(
    promptApiText().structuredOutput(options({ modelOptions: { maxCompletionTokens: 12 } })),
    (e: unknown) => (e as { code?: string }).code === "max_tokens"
  )
})

test("structured output reaching maxCompletionTokens with complete JSON still succeeds", async () => {
  control.answer = ['{"moveId":', '"b6-a5"}', "   "]
  const result = await promptApiText().structuredOutput(
    options({ modelOptions: { maxCompletionTokens: 18 } })
  )
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  assert.equal(result.rawText, '{"moveId":"b6-a5"}')
  assert.deepEqual(control.calls.map((c) => c.kind), ["stream"], "a capped answer streams to be counted")
  const details = (result.usage as { providerUsageDetails: Details }).providerUsageDetails
  assert.equal(details.outputTokenLimitReached, true)
  assert.equal(details.outputTokenLimit, 18)
})

test("maxCompletionTokens covers emulated reasoning: the draft and the answer share it", async () => {
  // Notes "think first" (11) leave 4 of 15 for the answer.
  control.answer = ["Hello ", "there"]
  let chunks = await collect(
    promptApiText().chatStream(
      chatOptions({ reasoning: { level: "high" }, modelOptions: { maxCompletionTokens: 15 } })
    )
  )
  assert.equal(
    chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta).join(""),
    "think first"
  )
  assert.equal(textIn(chunks), "Hell")
  assert.equal(chunks.at(-1)?.finishReason, "length")
  assert.equal(detailsOf(chunks.at(-1)).thinkingTokens, 11)

  // A cap the draft uses up leaves no answer.
  control.calls = []
  chunks = await collect(
    promptApiText().chatStream(
      chatOptions({ reasoning: { level: "high" }, modelOptions: { maxCompletionTokens: 8 } })
    )
  )
  assert.equal(
    chunks.filter((c) => c.type === "REASONING_MESSAGE_CONTENT").map((c) => c.delta).join(""),
    "think fi"
  )
  assert.equal(textIn(chunks), "")
  assert.equal(chunks.at(-1)?.finishReason, "length")
  const details = detailsOf(chunks.at(-1))
  assert.equal(details.thinkingTokens, 8)
  assert.equal(details.thinkingBudgetExhausted, false, "the cap, not a thinking budget, stopped it")
  assert.equal(control.calls.filter((c) => c.kind === "stream").length, 0)
})

/** Runs `body` with the browser's native tool-use classes defined. */
async function withNativeTools(body: () => Promise<void>) {
  const globals = globalThis as Record<string, unknown>
  const keys = ["LanguageModelToolCall", "LanguageModelToolSuccess", "LanguageModelToolError"]
  const saved = keys.map((key) => globals[key])
  class ToolValue {
    constructor(value: object) {
      Object.assign(this, value)
    }
  }
  for (const key of keys) globals[key] = ToolValue
  try {
    await body()
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete globals[key]
      else globals[key] = saved[i]
    })
  }
}

const lookup = {
  name: "lookup",
  description: "Look up a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  }
}
const nativeCall = (callId: string, city: string) => ({
  type: "tool-call",
  value: { callId, name: "lookup", arguments: { city } }
})

test("parallelToolCalls false keeps only the first of the browser's tool calls", async () => {
  await withNativeTools(async () => {
    for (const parallel of [false, true, undefined]) {
      control.answer = [nativeCall("a", "London"), nativeCall("b", "Paris")]
      const chunks = await collect(
        promptApiText().chatStream(
          chatOptions({
            threadId: `native-${String(parallel)}`,
            tools: [lookup],
            ...(parallel !== undefined && { modelOptions: { parallelToolCalls: parallel } })
          })
        )
      )
      const calls = chunks.filter((c) => c.type === "TOOL_CALL_END")
      assert.deepEqual(
        calls.map((c) => c.input),
        parallel === false ? [{ city: "London" }] : [{ city: "London" }, { city: "Paris" }]
      )
      assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
    }
  })
})

test("a native tool call the cap cuts into is left out, and the run finishes with length", async () => {
  await withNativeTools(async () => {
    control.answer = ["Sure", nativeCall("a", "London")]
    const chunks = await collect(
      promptApiText().chatStream(
        chatOptions({ threadId: "native-cut", tools: [lookup], modelOptions: { maxCompletionTokens: 10 } })
      )
    )
    assert.equal(textIn(chunks), "Sure")
    assert.equal(chunks.some((c) => c.type.startsWith("TOOL_CALL")), false)
    assert.equal(chunks.at(-1)?.finishReason, "length")
  })
})

test("guided tool arguments cut off by maxCompletionTokens send no call and finish with length", async () => {
  control.answer = ['{"city":', '"London"}']
  let chunks = await collect(
    promptApiText({ nativeTools: false }).chatStream(
      chatOptions({ tools: [lookup], toolChoice: "required", modelOptions: { maxCompletionTokens: 10 } })
    )
  )
  assert.equal(chunks.some((c) => c.type.startsWith("TOOL_CALL")), false)
  assert.equal(chunks.at(-1)?.finishReason, "length")
  assert.equal(detailsOf(chunks.at(-1)).outputTokenLimitReached, true)

  // Within the cap, the one guided call goes out; parallelToolCalls: false holds trivially.
  control.calls = []
  chunks = await collect(
    promptApiText({ nativeTools: false }).chatStream(
      chatOptions({
        threadId: "guided-ok",
        tools: [lookup],
        toolChoice: "required",
        modelOptions: { maxCompletionTokens: 100, parallelToolCalls: false }
      })
    )
  )
  assert.deepEqual(
    chunks.filter((c) => c.type === "TOOL_CALL_END").map((c) => c.input),
    [{ city: "London" }]
  )
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
})
