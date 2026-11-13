/**
 * useChat's connection. There is no server route: each run is TanStack AI's
 * `chat()`, here in the page, streamed to useChat with `stream()` (TanStack's
 * pattern for an in-process `chat()`). A server version would be
 * `fetchServerSentEvents` to a route running this same `chat()` with a
 * hosted model's adapter.
 */
import { chat, chatParamsFromRequestBody } from "@tanstack/ai"
import type { StreamChunk } from "@tanstack/ai"
import { stream } from "@tanstack/ai-react"

import { getMcpClients, reportMcpDiscoveryError } from "#/lib/mcp"
import { currentSystemPrompt } from "#/lib/settings"
import { locationToolDefinition, locationToolSetting } from "#/lib/location"
import { weatherTool, weatherToolSetting } from "#/lib/weather"
import { recordGeneration, startReply } from "./generation-stats"
import { replyStatsMiddleware } from "./call-stats"
import { ABORTED, untilAborted } from "./abortable"
import {
  confirmDownload,
  confirmDownloadMiddleware,
  downloadAnswer
} from "./download-interrupt"
import type { DownloadAnswer } from "./download-interrupt"
import { isReasoningLevel, selectedModel } from "./model"
import { messagesFor } from "./media"
import {
  effortFor,
  inputModalities,
  isModelId,
  modelInfo,
  pendingDownload,
  prepareModel
} from "./models"

/**
 * The model a run answers with: the one picked in a download confirmation
 * this run continues from, else the one its session forwarded, if it's one
 * we have.
 */
function readModel(
  forwarded: Record<string, unknown> | undefined,
  answer: DownloadAnswer | undefined
) {
  if (answer?.status === "resolved" && isModelId(answer.model)) {
    return answer.model
  }
  const model = forwarded?.model
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
 * needs it), and calls it again with their results until it answers. A
 * model that isn't on the device pauses the run first, to ask before it
 * downloads (./download-interrupt.ts).
 */
async function* reply(
  input: RunAgentInput,
  signal: AbortSignal | undefined
): AsyncIterable<StreamChunk> {
  const params = await chatParamsFromRequestBody(input)
  if (params.messages.at(-1)?.role === "user") startReply(params.threadId)
  // A continuation of a download confirmation carries its answer.
  const answer = downloadAnswer(params.resume)
  const model = readModel(params.forwardedProps, answer)
  const reasoning = effortFor(model, readEffort(params.forwardedProps))
  // Media the model can't read: refused in the message being answered (a
  // queued or regenerated one), left out of earlier ones for this model
  // only. The saved chat keeps it.
  const messages = messagesFor(
    params.messages,
    inputModalities(model),
    modelInfo(model).name
  )
  // stop() aborts the run, here in the page.
  const abortController = new AbortController()
  signal?.addEventListener("abort", () => abortController.abort(), {
    once: true
  })
  // A new run to a model that would download first asks before it does:
  // `chat()` pauses on the confirmation before its first model call, so
  // nothing loads. Its continuation carries the answer.
  const download = params.parentRunId ? undefined : await pendingDownload(model)
  if (abortController.signal.aborted) return
  // The model first, with its download's progress, unless the run is about
  // to ask, or the answer was no (the run then ends with no model call).
  // stop() returns at once, and cancels the download unless another run
  // still waits on it.
  if (!download && answer?.status !== "cancelled") {
    const failed = await untilAborted(
      prepareModel(model, abortController.signal),
      abortController.signal
    )
    if (failed === ABORTED || abortController.signal.aborted) return
    if (failed) throw failed
  }
  yield* chat({
    adapter: modelInfo(model).adapter,
    messages,
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
    interrupts: [confirmDownload],
    // The download confirmation, then each call's usage and its timings
    // measured from the stream, to the stats line, for this reply only.
    middleware: [
      confirmDownloadMiddleware(download),
      replyStatsMiddleware(recordGeneration)
    ],
    abortController
  })
}

export const browserChatConnection = stream((_messages, _data, signal, input) =>
  reply(input, signal)
)
