/**
 * useChat's connection. There is no server route: each run is TanStack AI's
 * `chat()`, here in the page, streamed to useChat with `stream()` (TanStack's
 * pattern for an in-process `chat()`). A server version would be
 * `fetchServerSentEvents` to a route running this same `chat()` with a
 * hosted model's adapter.
 */
import { chat, chatParamsFromRequestBody } from "@tanstack/ai"
import type { ChatMiddleware, StreamChunk } from "@tanstack/ai"
import { stream } from "@tanstack/ai-react"

import { getMcpClients, reportMcpDiscoveryError } from "#/lib/mcp"
import { currentSystemPrompt } from "#/lib/settings"
import { locationToolDefinition, locationToolSetting } from "#/lib/location"
import { weatherTool, weatherToolSetting } from "#/lib/weather"
import {
  recordGeneration,
  startReply,
  statsFromUsage
} from "./generation-stats"
import type { CallClock } from "./generation-stats"
import { ABORTED, untilAborted } from "./abortable"
import { isReasoningLevel, selectedModel } from "./model"
import { currentModelId, effortFor, isModelId, modelInfo, prepareModel } from "./models"

/** What the model generated: its first one is the call's first token, its last the end of decoding. */
const GENERATED = new Set<string>([
  "TEXT_MESSAGE_CONTENT",
  "REASONING_MESSAGE_CONTENT",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS"
])

/** Each model call's timings, measured here from its stream, by run and step. */
const clocks = new Map<string, CallClock>()

/**
 * Each model call's usage, as the adapter reports it when the call ends, to
 * the stats line, with timings measured from the stream where the adapter
 * reports none. A reply that calls tools makes one call per step.
 */
const replyStats: ChatMiddleware = {
  name: "reply-stats",
  onIteration: (ctx) => {
    clocks.set(`${ctx.runId}:${ctx.iteration}`, { start: performance.now() })
  },
  onChunk: (ctx, chunk) => {
    if (!GENERATED.has(chunk.type)) return
    const clock = clocks.get(`${ctx.runId}:${ctx.iteration}`)
    if (!clock) return
    clock.first ??= performance.now()
    clock.last = performance.now()
  },
  onUsage: (ctx, usage) => {
    const key = `${ctx.runId}:${ctx.iteration}`
    const clock = clocks.get(key)
    clocks.delete(key)
    recordGeneration(ctx.threadId, key, statsFromUsage(usage, clock))
  },
  // A call that fails or stops reports no usage.
  onModelError: (ctx) => void clocks.delete(`${ctx.runId}:${ctx.iteration}`),
  onAbort: (ctx) => void clocks.delete(`${ctx.runId}:${ctx.iteration}`)
}

/** The model a session forwarded with this run, if it's one we have. */
function readModel(forwarded: Record<string, unknown> | undefined) {
  const model = currentModelId(forwarded?.model)
  return isModelId(model) ? model : selectedModel()
}

/** The effort a session forwarded with this run, high if none. */
function readEffort(forwarded: Record<string, unknown> | undefined) {
  const effort = forwarded?.effort
  return isReasoningLevel(effort) ? effort : "high"
}

/** The AG-UI request useChat makes for a run. */
type RunAgentInput = Parameters<Parameters<typeof stream>[0]>[3]

/**
 * One reply: `chat()` with the forwarded model's adapter. It calls the
 * model, runs the tools it asks for (pausing for approval where a tool
 * needs it), and calls it again with their results until it answers.
 */
async function* reply(
  input: RunAgentInput,
  signal: AbortSignal | undefined
): AsyncIterable<StreamChunk> {
  const params = await chatParamsFromRequestBody(input)
  if (params.messages.at(-1)?.role === "user") startReply(params.threadId)
  const model = readModel(params.forwardedProps)
  const reasoning = effortFor(model, readEffort(params.forwardedProps))
  // stop() aborts the run, here in the page.
  const abortController = new AbortController()
  signal?.addEventListener("abort", () => abortController.abort(), {
    once: true
  })
  // The model first, with its download's progress. stop() returns at
  // once, and cancels the download unless another run still waits on it.
  const failed = await untilAborted(
    prepareModel(model, abortController.signal),
    abortController.signal
  )
  if (failed === ABORTED || abortController.signal.aborted) return
  if (failed) throw failed
  yield* chat({
    adapter: modelInfo(model).adapter,
    messages: params.messages,
    threadId: params.threadId,
    runId: params.runId,
    ...(params.parentRunId && { parentRunId: params.parentRunId }),
    ...(params.resume && { resume: params.resume }),
    // The user's system prompt from Settings, then the date.
    systemPrompts: [currentSystemPrompt()],
    // The built-in tools, unless turned off in Settings. The location tool
    // is a client tool: only its definition here, so the run pauses for
    // useChat to run its browser part (components/chat/thread.tsx).
    tools: [
      ...(weatherToolSetting.get() ? [weatherTool] : []),
      ...(locationToolSetting.get() ? [locationToolDefinition] : [])
    ],
    // The MCP servers' tools, Exa's web search first. The clients stay open
    // between runs; a server that fails to list its tools is left out.
    mcp: {
      clients: getMcpClients(),
      connection: "keep-alive",
      onDiscoveryError: reportMcpDiscoveryError
    },
    // The effort picked, clamped to the model's levels. Models that don't
    // reason get none. The type is the levels these adapters declare;
    // effortFor already picked one this model has.
    ...(reasoning && { reasoning: reasoning as "off" | "high" }),
    middleware: [replyStats],
    abortController
  })
}

export const browserChatConnection = stream((_messages, _data, signal, input) =>
  reply(input, signal)
)
