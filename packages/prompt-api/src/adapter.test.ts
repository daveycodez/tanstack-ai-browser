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
  /** The constrained answer, streamed in these pieces. */
  answer: ['{"moveId":', '"b6-a5"}'],
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
    return textOf(input).length
  }
  async prompt(input: unknown, options: Record<string, unknown> = {}) {
    control.calls.push({ kind: "prompt", input, options })
    if (control.failure) throw control.failure
    return control.answer.join("")
  }
  promptStreaming(input: unknown, options: Record<string, unknown> = {}) {
    const draft = textOf(input).includes("Write short working notes")
    control.calls.push({ kind: draft ? "draft" : "stream", input, options })
    const signal = options.signal as AbortSignal | undefined
    const pieces = draft ? control.notes : control.answer
    let index = 0
    return new ReadableStream<string>(
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
