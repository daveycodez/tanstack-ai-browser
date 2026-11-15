import assert from "node:assert/strict"
import { test } from "node:test"

import { chat, EventType, toolDefinition } from "@tanstack/ai"
import type { AdapterYieldChunk, TextOptions, TokenUsage } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"

import { replyStatsMiddleware } from "./call-stats.ts"
import { replyStatsOf } from "./reply-stats.ts"
import type { GenerationStats } from "./reply-stats.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

/** A count or timing the test reads: fails when it wasn't recorded. */
function recordedValue(value: number | undefined): number {
  assert.ok(value !== undefined, "not recorded")
  return value
}

/**
 * Streams text after a pause, or a tool call when the model hasn't seen a
 * tool result yet and `tool` is set. Reports `usage` when given: the Prompt
 * API reports none.
 */
class FakeAdapter extends BaseTextAdapter<"fake", Record<string, never>, ["text"], never> {
  readonly name = "fake"
  private readonly usage: TokenUsage | undefined
  private readonly tool: string | undefined
  constructor(usage?: TokenUsage, tool?: string) {
    super(undefined, "fake")
    this.usage = usage
    this.tool = tool
  }
  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? "run"
    const { threadId } = options
    const model = "fake"
    const timestamp = Date.now()
    yield { type: EventType.RUN_STARTED, runId, threadId, model, timestamp }
    await tick()
    const tool = this.tool && !options.messages.some((m) => m.role === "tool") ? this.tool : undefined
    if (tool) {
      const call = { toolCallId: "call-1", toolCallName: tool, model, timestamp }
      yield { type: EventType.TOOL_CALL_START, ...call, index: 0 }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: "{}", args: "{}", model, timestamp }
      yield { type: EventType.TOOL_CALL_END, toolCallId: "call-1", toolCallName: tool, input: {}, model, timestamp }
    } else {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", model, timestamp }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Hi", model, timestamp }
      await tick()
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: " there", model, timestamp }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: "m", model, timestamp }
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp,
      finishReason: tool ? "tool_calls" : "stop",
      ...(this.usage && { usage: this.usage })
    }
  }
  structuredOutput(): never {
    throw new Error("not used")
  }
}

/** One reply through `chat()`, and what it recorded, by call. */
async function reply(adapter: FakeAdapter, options: { tools?: Array<ReturnType<typeof clock>> } = {}) {
  const recorded = new Map<string, GenerationStats>()
  const stream = chat({
    adapter,
    threadId: "thread",
    runId: "run",
    messages: [{ role: "user", content: "hi" }],
    ...(options.tools && { tools: options.tools }),
    middleware: [
      replyStatsMiddleware((threadId, key, stats) => {
        assert.equal(threadId, "thread")
        recorded.set(key, stats)
      })
    ]
  })
  for await (const _ of stream) void _
  return recorded
}

const clock = () =>
  toolDefinition({ name: "clock", description: "The time" }).server(() => "noon")

test("a call with no usage (the Prompt API's) still records its time to first token and its stream time", async () => {
  const recorded = await reply(new FakeAdapter())
  assert.deepEqual([...recorded.keys()], ["run:0"])
  const stats = recorded.get("run:0")
  assert.ok(stats)
  assert.equal(stats.inputTokens, undefined)
  assert.equal(stats.outputTokens, undefined)
  assert.ok(recordedValue(stats.firstTokenMs) > 0, "measured time to first token")
  assert.equal(stats.promptMs, stats.firstTokenMs)
  assert.ok(recordedValue(stats.streamMs) > recordedValue(stats.firstTokenMs), "measured to the last token")
})

test("a call's usage adds its token counts to the same timings, for every step of a reply that calls a tool", async () => {
  const usage = { promptTokens: 20, completionTokens: 5, totalTokens: 25, promptTokensDetails: { cachedTokens: 8 } }
  const recorded = await reply(new FakeAdapter(usage, "clock"), { tools: [clock()] })
  assert.deepEqual([...recorded.keys()], ["run:0", "run:1"])
  for (const stats of recorded.values()) {
    assert.equal(stats.inputTokens, 20)
    assert.equal(stats.outputTokens, 5)
    assert.equal(stats.cachedTokens, 8)
    assert.ok(recordedValue(stats.firstTokenMs) > 0)
    assert.ok(recordedValue(stats.streamMs) >= recordedValue(stats.firstTokenMs))
  }
})

test("a cached count of 0 is kept (the whole prompt was read), and none reported stays unknown", async () => {
  const read = await reply(new FakeAdapter({ promptTokens: 20, completionTokens: 5, totalTokens: 25, promptTokensDetails: { cachedTokens: 0 } }))
  for (const stats of read.values()) assert.equal(stats.cachedTokens, 0)
  const unknown = await reply(new FakeAdapter({ promptTokens: 20, completionTokens: 5, totalTokens: 25 }))
  for (const stats of unknown.values()) assert.equal("cachedTokens" in stats, false)
})

test("prompt speed counts every step's input tokens over its time to first token, whatever a cache held or whether it says", async () => {
  // A tool call's step, its whole prompt cached, then the answer's step, its cached count unknown.
  const stats = replyStatsOf([
    { inputTokens: 1000, cachedTokens: 1000, promptMs: 500, outputTokens: 20, streamMs: 900 },
    { inputTokens: 2000, promptMs: 1500, outputTokens: 10, streamMs: 1700 }
  ])
  assert.ok(stats)
  assert.equal(stats.promptTokensPerSecond, 1500, "3,000 tokens in 2 s")
  assert.equal(stats.inputTokens, 2000, "the last step's prompt")
  // Through chat(): both steps of a reply that calls a tool are timed and counted.
  const recorded = await reply(new FakeAdapter({ promptTokens: 20, completionTokens: 5, totalTokens: 25 }, "clock"), { tools: [clock()] })
  const throughChat = replyStatsOf([...recorded.values()])
  assert.ok(throughChat)
  assert.ok(recordedValue(throughChat.promptTokensPerSecond) > 0)
})
