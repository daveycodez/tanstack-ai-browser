/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel's OpenAI-compatible server on the user's Mac. No backend
 * involved: the browser streams straight from it. Hand it to `chat()`
 * like any hosted model's adapter: `chat()` runs tools and the agent loop,
 * and each `chatStream` call here is one completion from apfel, streamed
 * back as AG-UI events.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type {
  AdapterYieldChunk,
  ModelMessage,
  ReasoningRequest,
  TextOptions,
  TokenUsage,
  Tool
} from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type {
  StructuredOutputOptions,
  StructuredOutputResult
} from "@tanstack/ai/adapters"

import {
  JSON_TOOL_CALLS_MARKER,
  createToolCallSplitter,
  parseJsonToolCalls
} from "./tool-calls.js"
import { matchToolName, repairToolArguments } from "./tool-repair.js"
import type { GuidedRequest } from "./tool-repair.js"

/** Where apfel's server listens by default. */
export const APFEL_BASE_URL = "http://127.0.0.1:11434/v1"

/** The models apfel serves: Apple's on-device Foundation Model. */
export const APFEL_TEXT_MODELS = ["apple-foundationmodel"] as const

/** A model apfel serves. */
export type ApfelTextModel = (typeof APFEL_TEXT_MODELS)[number] | (string & {})

export type ApfelTextConfig = {
  /** apfel's OpenAI-compatible API, up to `/v1`. `APFEL_BASE_URL` by default. */
  baseURL?: string
  /** Headers sent with every request, such as apfel's bearer token. */
  defaultHeaders?: Record<string, string>
}

/**
 * Timings of one model call, in milliseconds, in `RUN_FINISHED`'s
 * `usage.providerUsageDetails`. The adapter measures them as the stream
 * arrives; apfel itself reports token counts only.
 */
export type ApfelProviderUsageDetails = {
  /** From sending the request to the first generated text. */
  firstTokenMs?: number
  /** From the first generated text to the last. */
  decodeMs?: number
  /**
   * Tokens generated after the first chunk, estimated: apfel streams a few
   * tokens per chunk, and the first chunk's share of the characters stands
   * in for its share of the tokens.
   */
  decodeTokens?: number
  /**
   * Time spent rewriting the tool calls' arguments under their schemas,
   * after the reply ended (see the README's "Tool calls").
   */
  toolRepairMs?: number
  reasoningEmulated?: true
  reasoningTokenMeasurement?: "provider-usage"
  reasoningBudgetEnforcement?: "server-output-limit"
  thinkingTokens?: number
  thinkingBudgetTokens?: number
  /** Effective draft output cap, when supplied by the caller. */
  thinkingOutputLimitTokens?: number
  thinkingBudgetExhausted?: boolean
  reasoningMs?: number
}

/**
 * Per-call `modelOptions`: the fields of TanStack's OpenRouter adapter
 * (the OpenRouter SDK's camelCase chat request) that Apple's model takes.
 * apfel rejects the ones it doesn't (`stop`, `frequencyPenalty`,
 * `presencePenalty`, n…) with HTTP 400.
 */
export type ApfelModelOptions = {
  /** The most tokens the reply may have (sent as `max_tokens`). */
  maxCompletionTokens?: number
  temperature?: number
  /** Nucleus sampling threshold, in (0, 1] (sent as `top_p`). */
  topP?: number
  seed?: number
}

/** `modelOptions` as apfel's request fields. */
function nativeModelOptions(options: ApfelModelOptions | undefined) {
  const { maxCompletionTokens: limit, temperature, topP, seed } = options ?? {}
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError("maxCompletionTokens must be a nonnegative safe integer.")
  return {
    ...(temperature !== undefined && { temperature }),
    ...(seed !== undefined && { seed }),
    ...(topP !== undefined && { top_p: topP }),
    ...(limit !== undefined && { max_tokens: limit })
  }
}

export type ApfelReasoning = { levels: "off" | "high"; budget: true }

function reasoningOptions(request: ReasoningRequest | undefined) {
  const budget = request?.budgetTokens
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  }
  if (request?.level !== undefined && request.level !== "off" && request.level !== "high") {
    throw new RangeError("Apfel emulated reasoning supports off or high.")
  }
  return { enabled: request?.level === "high", budget }
}

type DraftReasoning = {
  notes: string
  usage?: OpenAIUsage
  details?: ApfelProviderUsageDetails
}

function withWorkingNotes(messages: Array<OpenAIMessage>, notes: string) {
  if (!notes) return messages
  const instruction = `Working notes to verify against the conversation:\n${notes}\nAnswer the original request above or make the required tool call. Do not return these notes.`
  // Keep the real current turn and its tool-result ordering intact. A new user
  // message here can make Apple's model answer the notes instead of the request.
  const user = messages.map((message) => message.role).lastIndexOf("user")
  return user < 0
    ? [...messages, { role: "user" as const, content: instruction }]
    : messages.map((message, index) => index === user
      ? { ...message, content: `${message.content}\n\n${instruction}` }
      : message)
}

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

type OpenAIToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: Array<OpenAIToolCall>
    }
  | { role: "tool"; tool_call_id: string; content: string }

type OpenAITool = {
  type: "function"
  function: { name: string; description: string; parameters: unknown }
}

type FinishReason = "stop" | "length" | "content_filter" | "tool_calls" | null

type OpenAIUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

type OpenAIChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      refusal?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: FinishReason
  }>
  /** Sent in a last chunk of its own when asked for with include_usage. */
  usage?: OpenAIUsage | null
  error?: { message?: string }
}

type OpenAICompletion = {
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null }
    finish_reason?: FinishReason
  }>
  usage?: OpenAIUsage | null
}

/**
 * A tool result for the model. A failed tool gives its error message, so the
 * model can see what went wrong and try again.
 */
function toolResultText(m: ModelMessage) {
  const text = contentText(m.content)
  if (m.error) return `Error: ${m.error}`
  return text && text !== "null" ? text : "The tool returned nothing."
}

function contentText(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return (content ?? [])
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("")
}

/**
 * The conversation in OpenAI's chat format. Tool calls and results from
 * earlier turns are left out; their answers stay. With them in the history,
 * Apple's model writes its next tool call as broken JSON text most of the
 * time (4 of 12 calls worked, against 12 of 12 without). The current turn's
 * calls and results are kept: the model answers from them.
 */
function toOpenAIMessages(messages: Array<ModelMessage>): Array<OpenAIMessage> {
  const out: Array<OpenAIMessage> = []
  const currentTurn = messages.map((m) => m.role).lastIndexOf("user")
  for (const [i, m] of messages.entries()) {
    const earlierToolStep =
      i < currentTurn &&
      (m.role === "tool" || (m.role === "assistant" && m.toolCalls?.length))
    const content = contentText(m.content)
    if (earlierToolStep) {
      if (m.role === "assistant" && content) {
        out.push({ role: "assistant", content })
      }
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: toolResultText(m)
      })
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: call.function
        }))
      })
    } else if (content) {
      out.push({ role: m.role === "user" ? "user" : "assistant", content })
    }
  }
  return out
}

/** Tools as OpenAI function tools; `inputSchema` is already JSON Schema. */
function toOpenAITools(tools: Array<Tool> | undefined): Array<OpenAITool> {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: "object",
        properties: {},
        required: []
      }
    }
  }))
}

/**
 * `tool_choice` for the request. "auto" is apfel's default and is left out,
 * so a plain request is sent exactly as before.
 */
function toolChoice(choice: TextOptions["toolChoice"]) {
  if (!choice || choice === "auto") return {}
  if (typeof choice === "string") return { tool_choice: choice }
  return {
    tool_choice: { type: "function", function: { name: choice.name } }
  }
}

/** The system prompts as one system message, if there are any. */
function systemMessages(
  prompts: TextOptions["systemPrompts"]
): Array<OpenAIMessage> {
  const system = normalizeSystemPrompts(prompts)
    .map((p) => p.content)
    .join("\n\n")
  return system ? [{ role: "system", content: system }] : []
}

/** Yields the `data:` payloads of an SSE response body. */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith("data:")) yield line.slice(5).trim()
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** A tool call's JSON arguments, or undefined if they aren't a JSON object. */
function parseArguments(json: string): Record<string, unknown> | undefined {
  try {
    const args = JSON.parse(json) as unknown
    return args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The message of apfel's `{"error": {"message"}}` body, or the raw body. */
async function errorBody(response: Response) {
  const raw = await response.text().catch(() => "")
  try {
    const message = (JSON.parse(raw) as OpenAIChunk).error?.message
    if (message) return message
  } catch {
    // Not JSON: the raw body says what it says.
  }
  return raw.slice(0, 200)
}

/** apfel's token counts as TanStack AI usage, with the call's timings. */
function usageOf(
  usage: OpenAIUsage | null | undefined,
  details?: ApfelProviderUsageDetails,
  draft?: OpenAIUsage
): TokenUsage | undefined {
  if (
    usage?.prompt_tokens === undefined ||
    usage.completion_tokens === undefined
  ) {
    return undefined
  }
  const promptTokens = usage.prompt_tokens + (draft?.prompt_tokens ?? 0)
  const completionTokens = usage.completion_tokens + (draft?.completion_tokens ?? 0)
  const result = buildBaseUsage<ApfelProviderUsageDetails>({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  })
  if (draft?.completion_tokens !== undefined) {
    result.completionTokensDetails = { reasoningTokens: draft.completion_tokens }
  }
  const cachedTokens = (usage.prompt_tokens_details?.cached_tokens ?? 0) + (draft?.prompt_tokens_details?.cached_tokens ?? 0)
  if (cachedTokens) result.promptTokensDetails = { cachedTokens }
  if (details && Object.keys(details).length > 0) {
    result.providerUsageDetails = details
  }
  return result
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const unreachable = (baseURL: string) => `Couldn't reach apfel at ${baseURL}.`

let ids = 0
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** Where a chunk came from, in `metadata.tanstack.source`. */
type ChunkSource = { provider: string; api: string; model: string }

const sourceOf = (
  adapter: { provider: string; api: string; model: string },
  model: string | undefined
): ChunkSource => ({
  provider: adapter.provider,
  api: adapter.api,
  model: model ?? adapter.model
})

/** A chunk tagged with its source, as TanStack's own adapters tag theirs. */
function withSource(chunk: AdapterYieldChunk, source: ChunkSource): AdapterYieldChunk {
  const metadata = chunk.metadata as Record<string, unknown> | undefined
  return {
    ...chunk,
    metadata: {
      ...metadata,
      tanstack: {
        ...(metadata?.tanstack as Record<string, unknown> | undefined),
        source
      }
    }
  }
}

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions<ApfelModelOptions>) =>
  options.abortController?.signal ??
  (options.request as RequestInit | undefined)?.signal ??
  undefined

/** A structured answer that failed, with the `RUN_ERROR` code it streams as. */
class StructuredOutputFailure extends Error {
  constructor(
    message: string,
    readonly code: "parse-error" | "empty-response" | "refusal" | "max_tokens",
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "StructuredOutputFailure"
  }
}

/** A structured answer, with the reasoning written before it. */
type StructuredRunResult = StructuredOutputResult<unknown> & {
  reasoning?: string
}

type StreamedCall = { name: string; arguments: string }

export class ApfelTextAdapter<TModel extends string> extends BaseTextAdapter<
  TModel,
  ApfelModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ApfelReasoning
> {
  override readonly kind = "text" as const
  readonly name = "apfel" as const
  override readonly provider = "apfel" as const
  override readonly api = "openai-completions" as const
  override readonly inputModalities = ["text"] as const
  private readonly baseURL: string
  private readonly headers: Record<string, string>

  constructor(config: ApfelTextConfig, model: TModel) {
    super({}, model)
    this.baseURL = (config.baseURL ?? APFEL_BASE_URL).replace(/\/+$/, "")
    this.headers = {
      ...config.defaultHeaders,
      "Content-Type": "application/json"
    }
  }

  /** A separate, tool-free completion; its output never enters caller history. */
  private async *draftReasoning(
    options: TextOptions<ApfelModelOptions>,
    signal: AbortSignal | undefined,
    send: typeof fetch,
    budget: number | undefined,
    draft: DraftReasoning
  ): AsyncGenerator<AdapterYieldChunk> {
    signal?.throwIfAborted()
    const began = performance.now()
    const modelOptions = nativeModelOptions(options.modelOptions)
    // A thinking budget can narrow a caller's cap, but never raises it.
    const limit = budget === undefined ? modelOptions.max_tokens
      : modelOptions.max_tokens === undefined ? budget : Math.min(budget, modelOptions.max_tokens)
    draft.details = {
      reasoningEmulated: true,
      reasoningTokenMeasurement: "provider-usage",
      reasoningBudgetEnforcement: "server-output-limit",
      ...(budget !== undefined && { thinkingBudgetTokens: budget }),
      ...(limit !== undefined && { thinkingOutputLimitTokens: limit }),
      thinkingBudgetExhausted: false
    }
    if (limit === 0) {
      draft.details.thinkingTokens = 0
      draft.details.thinkingBudgetExhausted = budget === 0
      draft.details.reasoningMs = performance.now() - began
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", cancel, { once: true })
    const id = nextId("reasoning")
    const event = { messageId: id, model: this.model }
    let opened = false
    let finish: FinishReason = null
    try {
      options.logger.request(`activity=reasoning-draft provider=apfel model=${this.model} stream=true`, { provider: "apfel", model: this.model })
      const response = await send(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...modelOptions,
          ...(limit !== undefined && { max_tokens: limit }),
          model: this.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            ...systemMessages(options.systemPrompts),
            ...toOpenAIMessages(options.messages),
            { role: "user", content: "Write short working notes for the next response. Use facts already available in the conversation. Do not call tools or give the final response yet." }
          ]
        }),
        signal: controller.signal
      })
      signal?.throwIfAborted()
      if (!response.ok || !response.body) {
        throw new Error(`apfel returned HTTP ${response.status}: ${await errorBody(response)}`)
      }
      for await (const data of sseData(response.body)) {
        signal?.throwIfAborted()
        if (data === "[DONE]") break
        const chunk = JSON.parse(data) as OpenAIChunk
        if (chunk.error) throw new Error(chunk.error.message ?? "apfel sent an error.")
        draft.usage = chunk.usage ?? draft.usage
        const choice = chunk.choices?.[0]
        finish = choice?.finish_reason ?? finish
        const delta = choice?.delta?.content ?? choice?.delta?.reasoning_content
        if (!delta) continue
        if (!opened) {
          opened = true
          yield { ...event, type: EventType.REASONING_START, timestamp: Date.now() }
          yield { ...event, type: EventType.REASONING_MESSAGE_START, role: "reasoning", timestamp: Date.now() }
        }
        draft.notes += delta
        yield { ...event, type: EventType.REASONING_MESSAGE_CONTENT, delta, timestamp: Date.now() }
      }
      signal?.throwIfAborted()
      draft.details.thinkingTokens = draft.usage?.completion_tokens
      // Use the server's finish reason: its usage accounting can include tokens
      // beyond the configured generation cap, so count comparisons are unreliable.
      draft.details.thinkingBudgetExhausted = budget !== undefined && finish === "length" && limit === budget
      draft.details.reasoningMs = performance.now() - began
      if (opened) {
        yield { ...event, type: EventType.REASONING_MESSAGE_END, timestamp: Date.now() }
        yield { ...event, type: EventType.REASONING_END, timestamp: Date.now() }
      }
    } finally {
      signal?.removeEventListener("abort", cancel)
      // Close only the draft transport, including when a consumer leaves early.
      controller.abort()
    }
  }

  async *chatStream(
    options: TextOptions<ApfelModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.model)
    for await (const chunk of this.chatStreamRequest(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *chatStreamRequest(
    options: TextOptions<ApfelModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const emulation = reasoningOptions(options.reasoning)
    const runId = options.runId ?? nextId("run")
    const threadId = options.threadId
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const model = this.model
    const { logger } = options
    const signal =
      options.abortController?.signal ??
      (options.request as RequestInit | undefined)?.signal ??
      undefined
    const timestamp = () => Date.now()
    const runError = (message: string): AdapterYieldChunk => ({
      type: EventType.RUN_ERROR,
      runId,
      model,
      timestamp: timestamp(),
      message,
      error: { message }
    })

    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }

    const tools = toOpenAITools(options.tools)
    const toolNames = new Set(tools.map((tool) => tool.function.name))
    const send = options.wrapFetch ? options.wrapFetch(fetch) : fetch
    const url = `${this.baseURL}/chat/completions`
    logger.request(
      `activity=chat provider=apfel model=${model} messages=${options.messages.length} tools=${tools.length} stream=true`,
      { provider: "apfel", model }
    )
    const sentAt = performance.now()
    let response: Response
    const draft: DraftReasoning = { notes: "" }
    try {
      if (emulation.enabled) yield* this.draftReasoning(options, signal, send, emulation.budget, draft)
    } catch (error) {
      if (signal?.aborted) return
      yield runError(`apfel's reasoning draft failed: ${errorText(error)}`)
      return
    }
    try {
      signal?.throwIfAborted()
      response = await send(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...nativeModelOptions(options.modelOptions),
          model,
          stream: true,
          // Token counts, for the stats.
          stream_options: { include_usage: true },
          messages: withWorkingNotes([
            ...systemMessages(options.systemPrompts),
            ...toOpenAIMessages(options.messages)
          ], draft.notes),
          ...(tools.length > 0 && {
            tools,
            ...toolChoice(options.toolChoice)
          })
        }),
        signal
      })
    } catch (error) {
      if (signal?.aborted) return
      logger.errors("apfel.chatStream fetch failed", {
        error,
        source: "apfel.chatStream"
      })
      yield runError(unreachable(this.baseURL))
      return
    }
    if (!response.ok || !response.body) {
      yield runError(
        `apfel returned HTTP ${response.status}: ${await errorBody(response)}`
      )
      return
    }

    // Reasoning (apfel sends none for Apple's model today) streams as
    // reasoning events, then the answer as text up to any tool call the
    // model wrote as text, which is held back and parsed at the end.
    let reasoning: "none" | "open" | "closed" = "none"
    let textStarted = false
    let text = ""
    const events: Array<AdapterYieldChunk> = []
    const endReasoning = () => {
      if (reasoning !== "open") return
      reasoning = "closed"
      events.push(
        {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningId,
          model,
          timestamp: timestamp()
        },
        {
          type: EventType.REASONING_END,
          messageId: reasoningId,
          model,
          timestamp: timestamp()
        }
      )
    }
    const addReasoning = (delta: string) => {
      if (reasoning === "none") {
        events.push(
          {
            type: EventType.REASONING_START,
            messageId: reasoningId,
            model,
            timestamp: timestamp()
          },
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId: reasoningId,
            role: "reasoning",
            model,
            timestamp: timestamp()
          }
        )
      }
      reasoning = "open"
      events.push({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta,
        model,
        timestamp: timestamp()
      })
    }
    const addText = (delta: string) => {
      if (!delta) return
      endReasoning()
      if (!textStarted) {
        textStarted = true
        events.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          model,
          timestamp: timestamp()
        })
      }
      text += delta
      events.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta,
        content: text,
        model,
        timestamp: timestamp()
      })
    }
    const endText = () => {
      if (!textStarted) return
      textStarted = false
      events.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: timestamp()
      })
    }

    // When apfel doesn't recognize a tool call, it passes it on as text;
    // that part is held back and read once the reply ends.
    const splitter = createToolCallSplitter(JSON_TOOL_CALLS_MARKER)
    // Tool calls stream in pieces, by index.
    const streamed: Array<StreamedCall> = []
    // apfel streams a few tokens per chunk: the first chunk's share of the
    // characters stands in for its share of the tokens.
    const timing = { first: 0, last: 0, firstChars: 0, chars: 0 }
    let usage: OpenAIChunk["usage"]
    let finishReason: FinishReason = null
    try {
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") break
        const chunk = JSON.parse(data) as OpenAIChunk
        logger.provider("provider=apfel", { chunk })
        if (chunk.error) {
          throw new Error(chunk.error.message ?? "apfel sent an error.")
        }
        usage = chunk.usage ?? usage
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        const chars =
          (delta?.content?.length ?? 0) +
          (delta?.reasoning_content?.length ?? 0) +
          (delta?.tool_calls ?? []).reduce(
            (n, piece) =>
              n +
              (piece.function?.name?.length ?? 0) +
              (piece.function?.arguments?.length ?? 0),
            0
          )
        if (chars > 0) {
          timing.last = performance.now()
          if (!timing.first) {
            timing.first = timing.last
            timing.firstChars = chars
          }
          timing.chars += chars
        }
        if (delta?.reasoning_content) addReasoning(delta.reasoning_content)
        if (delta?.content) addText(splitter.push(delta.content))
        for (const piece of delta?.tool_calls ?? []) {
          // apfel numbers its calls call_1, call_2… in every response; the
          // adapter gives them ids of its own that are unique in the thread.
          const call = (streamed[piece.index] ??= { name: "", arguments: "" })
          call.name += piece.function?.name ?? ""
          call.arguments += piece.function?.arguments ?? ""
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        yield* events.splice(0)
      }
    } catch (error) {
      if (signal?.aborted) return
      logger.errors("apfel.chatStream stream failed", {
        error,
        source: "apfel.chatStream"
      })
      endReasoning()
      endText()
      yield* events.splice(0)
      yield runError(`apfel's stream failed: ${errorText(error)}`)
      return
    }

    const outputTokens = usage?.completion_tokens
    const details: ApfelProviderUsageDetails = timing.first
      ? {
          firstTokenMs: timing.first - sentAt,
          decodeMs: timing.last - timing.first,
          ...(outputTokens !== undefined && {
            decodeTokens:
              (outputTokens * (timing.chars - timing.firstChars)) /
              timing.chars
          })
        }
      : {}

    endReasoning()
    const { text: rest, markup } = splitter.flush()
    const fromText =
      markup && streamed.length === 0
        ? parseJsonToolCalls(markup, toolNames)
        : []
    // Text that wasn't a readable tool call is shown after all.
    addText(`${rest}${fromText.length > 0 ? "" : (markup ?? "")}`)
    yield* events.splice(0)

    // Calls to tools that don't exist are passed on too: `chat()` answers
    // them with an "Unknown tool" error, so the model can answer with what
    // it has instead of stopping there.
    const calls = [
      ...streamed.filter((call) => call?.name),
      ...fromText.map((call) => ({
        name: call.name,
        arguments: JSON.stringify(call.args)
      }))
    ].map((call) => ({
      ...call,
      name: matchToolName(call.name, toolNames) ?? call.name
    }))
    let repairMs = 0
    for (const [index, call] of calls.entries()) {
      const toolCallId = nextId("tool")
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: call.name,
        parentMessageId: messageId,
        index,
        model,
        timestamp: timestamp()
      }
      const tool = options.tools?.find((t) => t.name === call.name)
      const repairStart = performance.now()
      const repaired = tool
        ? await this.repairArguments(
            tool,
            call.arguments,
            options,
            send,
            signal
          )
        : undefined
      repairMs += performance.now() - repairStart
      if (signal?.aborted) return
      const args = repaired ? JSON.stringify(repaired) : call.arguments || "{}"
      const input = repaired ?? parseArguments(args)
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: args,
        args,
        model,
        timestamp: timestamp()
      }
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId,
        toolCallName: call.name,
        args,
        // Arguments that aren't JSON are left out; `chat()` reports them.
        ...(input && { input }),
        model,
        timestamp: timestamp()
      }
    }
    endText()
    yield* events.splice(0)

    Object.assign(details, draft.details)
    if (repairMs > 0) details.toolRepairMs = repairMs
    const finishUsage = usageOf(usage, details, draft.usage)
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason:
        calls.length > 0
          ? "tool_calls"
          : finishReason === "tool_calls" || finishReason === null
            ? "stop"
            : finishReason,
      ...(finishUsage && { usage: finishUsage })
    }
  }

  /**
   * A tool call's arguments, written again under the tool's schema with
   * guided generation. Undefined if the tool takes no arguments or a request
   * failed: the model's own arguments are used then.
   */
  private async repairArguments(
    tool: Tool,
    draft: string,
    options: TextOptions<ApfelModelOptions>,
    send: typeof fetch,
    signal: AbortSignal | undefined
  ) {
    const system = normalizeSystemPrompts(options.systemPrompts)
      .map((p) => p.content)
      .join("\n\n")
    const messages = toOpenAIMessages(options.messages)
    const complete = async ({ instructions, schema, name }: GuidedRequest) => {
      options.logger.request(
        `activity=tool-repair provider=apfel model=${this.model} tool=${tool.name} step=${name}`,
        { provider: "apfel", model: this.model }
      )
      const response = await send(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...nativeModelOptions(options.modelOptions),
          model: this.model,
          // apfel takes one system message, and the conversation must end
          // with the user or a tool result: the instructions go first.
          messages: [
            {
              role: "system",
              content: system
                ? `${instructions}\n\nThe assistant's instructions, for context:\n${system}`
                : instructions
            },
            ...messages
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name, schema }
          }
        }),
        signal
      })
      if (!response.ok) {
        throw new Error(
          `apfel returned HTTP ${response.status}: ${await errorBody(response)}`
        )
      }
      const completion = (await response.json()) as OpenAICompletion
      const text = (completion.choices?.[0]?.message?.content ?? "").trim()
      return JSON.parse(
        text.replace(/^```(?:json)?\s*|\s*```$/g, "")
      ) as unknown
    }
    try {
      return await repairToolArguments(tool, complete, draft)
    } catch (error) {
      if (!signal?.aborted) {
        options.logger.errors("apfel tool-call repair failed", {
          error,
          source: "apfel.repairArguments"
        })
      }
      return undefined
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`, from apfel's JSON mode:
   * `response_format: json_schema` constrains Apple's model to the schema
   * (guided generation). `chat()` validates the result. One request, not
   * streamed; the streamed form is `structuredOutputStream`.
   */
  async structuredOutput(
    options: StructuredOutputOptions<ApfelModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const run = this.structuredOutputRun(options, false)
    let next = await run.next()
    while (!next.done) next = await run.next()
    const { data, rawText, model, usage } = next.value
    return { data, rawText, model, ...(usage && { usage }) }
  }

  /**
   * `chat({ outputSchema, stream: true })`: one streamed request with
   * `response_format: json_schema`, after any emulated reasoning
   * (`REASONING_*`), then `structured-output.complete` and `RUN_FINISHED`.
   * apfel (v1.16) sends a constrained answer as a single delta once it's
   * done, so the JSON arrives in one `TEXT_MESSAGE_CONTENT`.
   */
  async *structuredOutputStream(
    options: StructuredOutputOptions<ApfelModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.chatOptions.model)
    for await (const chunk of this.structuredOutputRequestStream(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *structuredOutputRequestStream(
    options: StructuredOutputOptions<ApfelModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const { chatOptions } = options
    const runId = chatOptions.runId ?? nextId("run")
    const threadId = chatOptions.threadId
    const messageId = nextId("msg")
    const model = this.model
    const signal = signalOf(chatOptions)
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: Date.now(),
      ...(chatOptions.parentRunId && { parentRunId: chatOptions.parentRunId })
    }
    let result: StructuredRunResult
    try {
      result = yield* this.structuredOutputRun(options, true, messageId)
    } catch (error) {
      const aborted = !!signal?.aborted
      const code = aborted
        ? "aborted"
        : error instanceof StructuredOutputFailure
          ? error.code
          : undefined
      const message = errorText(aborted ? (signal?.reason ?? error) : error)
      if (!aborted) {
        chatOptions.logger.errors("apfel.structuredOutputStream fatal", {
          error,
          source: "apfel.structuredOutputStream"
        })
      }
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: Date.now(),
        message,
        ...(code && { code }),
        error: { message, ...(code && { code }) }
      }
      return
    }
    yield {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: {
        object: result.data,
        raw: result.rawText,
        ...(result.reasoning ? { reasoning: result.reasoning } : {})
      },
      model,
      timestamp: Date.now()
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: Date.now(),
      finishReason: "stop",
      ...(result.usage && { usage: result.usage })
    }
  }

  /**
   * One structured answer: the emulated reasoning draft (if asked for) as
   * `REASONING_*` events, then the constrained JSON as `TEXT_MESSAGE_*`
   * deltas (`stream`: from a streamed request; otherwise one request whose
   * whole answer is one delta). Throws on failure and cancellation.
   */
  private async *structuredOutputRun(
    options: StructuredOutputOptions<ApfelModelOptions>,
    stream: boolean,
    messageId = nextId("msg")
  ): AsyncGenerator<AdapterYieldChunk, StructuredRunResult> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    signal?.throwIfAborted()
    const emulation = reasoningOptions(chatOptions.reasoning)
    const model = this.model
    const send = chatOptions.wrapFetch ? chatOptions.wrapFetch(fetch) : fetch
    chatOptions.logger.request(
      `activity=${stream ? "structuredOutputStream" : "structuredOutput"} provider=apfel model=${model} messages=${chatOptions.messages.length} tools=0 stream=${stream}`,
      { provider: "apfel", model }
    )
    const draft: DraftReasoning = { notes: "" }
    if (emulation.enabled) {
      yield* this.draftReasoning(chatOptions, signal, send, emulation.budget, draft)
    }
    let response: Response
    try {
      signal?.throwIfAborted()
      response = await send(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...nativeModelOptions(chatOptions.modelOptions),
          model,
          ...(stream && {
            stream: true,
            stream_options: { include_usage: true }
          }),
          messages: withWorkingNotes([
            ...systemMessages(chatOptions.systemPrompts),
            ...toOpenAIMessages(chatOptions.messages)
          ], draft.notes),
          response_format: {
            type: "json_schema",
            json_schema: { name: "output", schema: outputSchema }
          }
        }),
        signal
      })
    } catch (error) {
      chatOptions.logger.errors("apfel.structuredOutput fetch failed", {
        error,
        source: "apfel.structuredOutput"
      })
      if (signal?.aborted) throw error
      throw new Error(unreachable(this.baseURL), { cause: error })
    }
    signal?.throwIfAborted()
    if (!response.ok) {
      throw new Error(
        `apfel returned HTTP ${response.status}: ${await errorBody(response)}`
      )
    }

    let content = ""
    let refusal = ""
    let usage: OpenAIUsage | null | undefined
    let finishReason: FinishReason = null
    let textStarted = false
    let reasoningId: string | undefined
    let nativeReasoning = ""
    const endReasoning = function* (): Generator<AdapterYieldChunk> {
      if (!reasoningId) return
      yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: Date.now() }
      yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: Date.now() }
      reasoningId = undefined
    }
    const addText = function* (delta: string): Generator<AdapterYieldChunk> {
      if (!delta) return
      yield* endReasoning()
      if (!textStarted) {
        textStarted = true
        yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: Date.now() }
      }
      content += delta
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content, model, timestamp: Date.now() }
    }
    // A server that ignores `stream` answers with one JSON completion.
    const streamed =
      stream &&
      !!response.body &&
      !(response.headers.get("content-type") ?? "").includes("application/json")
    if (streamed && response.body) {
      for await (const data of sseData(response.body)) {
        signal?.throwIfAborted()
        if (data === "[DONE]") break
        const chunk = JSON.parse(data) as OpenAIChunk
        chatOptions.logger.provider("provider=apfel", { chunk })
        if (chunk.error) throw new Error(chunk.error.message ?? "apfel sent an error.")
        usage = chunk.usage ?? usage
        const choice = chunk.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (delta?.reasoning_content) {
          if (!reasoningId) {
            reasoningId = nextId("reasoning")
            yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: Date.now() }
            yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: Date.now() }
          }
          nativeReasoning += delta.reasoning_content
          yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: delta.reasoning_content, model, timestamp: Date.now() }
        }
        if (delta?.refusal) refusal += delta.refusal
        if (delta?.content) yield* addText(delta.content)
      }
    } else {
      // The whole answer at once (or a server that answered a streamed
      // request without streaming it).
      const completion = (await response.json()) as OpenAICompletion
      signal?.throwIfAborted()
      const choice = completion.choices?.[0]
      usage = completion.usage
      finishReason = choice?.finish_reason ?? null
      refusal = choice?.message?.refusal ?? ""
      yield* addText(choice?.message?.content ?? "")
    }
    yield* endReasoning()
    if (textStarted) {
      yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: Date.now() }
    }
    signal?.throwIfAborted()
    if (finishReason === "length") {
      throw new StructuredOutputFailure(
        "apfel's answer was cut off at the token limit before its JSON ended; raise modelOptions.maxCompletionTokens.",
        "max_tokens"
      )
    }
    const rawText = content.trim()
    if (!rawText) {
      throw refusal
        ? new StructuredOutputFailure(`Model refused: ${refusal}`, "refusal")
        : new StructuredOutputFailure("apfel's answer is empty.", "empty-response")
    }
    const json = rawText.replace(/^```(?:json)?\s*|\s*```$/g, "")
    let data: unknown
    try {
      data = JSON.parse(json) as unknown
    } catch (error) {
      throw new StructuredOutputFailure(
        `The model's answer isn't JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? "…" : ""}`,
        "parse-error",
        error
      )
    }
    const finishUsage = usageOf(usage, draft.details, draft.usage)
    const reasoning = draft.notes + nativeReasoning
    return {
      data,
      rawText,
      model,
      ...(finishUsage && { usage: finishUsage }),
      ...(reasoning && { reasoning })
    }
  }
}

/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel.
 *
 * @example
 * ```ts
 * chat({
 *   adapter: apfelText("apple-foundationmodel", { baseURL: APFEL_BASE_URL }),
 *   messages,
 *   threadId
 * })
 * ```
 */
export function apfelText<TModel extends ApfelTextModel>(
  model: TModel,
  config: ApfelTextConfig = {}
): ApfelTextAdapter<TModel> {
  return new ApfelTextAdapter(config, model)
}

/**
 * Whether apfel is running and serves the model: true if `GET /v1/models`
 * lists it within 10 seconds.
 */
export async function isApfelAvailable(
  model: ApfelTextModel,
  config: ApfelTextConfig = {}
) {
  const baseURL = (config.baseURL ?? APFEL_BASE_URL).replace(/\/+$/, "")
  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: { ...config.defaultHeaders },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) return false
    const list = (await response.json()) as { data?: Array<{ id?: string }> }
    return list.data?.some((m) => m.id === model) ?? false
  } catch {
    return false
  }
}
