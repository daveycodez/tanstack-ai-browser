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

import { toGuidedSchema, withoutNulls } from "./guided-schema.js"

import type { ApfelChatModel } from "./model-meta.js"

/** Where apfel's server listens by default. */
const APFEL_BASE_URL = "http://127.0.0.1:11434/v1"

/** A model apfel serves: a listed one, or any other id apfel lists. */
export type ApfelTextModel = ApfelChatModel | (string & {})

export type ApfelConfig = {
  /** apfel's OpenAI-compatible API, up to `/v1`. `http://127.0.0.1:11434/v1` by default. */
  baseURL?: string
  /** Headers sent with every request, such as apfel's bearer token. */
  defaultHeaders?: Record<string, string>
  /**
   * Download progress, as the in-browser adapters take it. Apple's model is
   * on the Mac already, so nothing downloads: `create`
   * reports 1 once apfel answers.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Where a model stands, with the Prompt API's values
 * (`LanguageModel.availability()`): "unavailable", "downloadable",
 * "downloading" or "available". apfel's model is "available" when apfel
 * answers, else "unavailable"; it never downloads.
 */
export type Availability =
  "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1 (apfel's model never downloads: it hears 1). */
export type DownloadProgressCallback = (progress: number) => void

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
   * Time the guided tool step took: the request in which the model picks a
   * tool and writes its arguments, or picks "answer" (see the README's "Tool
   * calls").
   */
  toolStepMs?: number
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
export type ApfelTextModelOptions = {
  /** The most tokens the reply may have (sent as `max_tokens`). */
  maxCompletionTokens?: number
  temperature?: number
  /** Nucleus sampling threshold, in (0, 1] (sent as `top_p`). */
  topP?: number
  seed?: number
  /**
   * False keeps a reply to one tool call (sent as `parallel_tool_calls`
   * with tools). True or left out: as many as the model writes.
   */
  parallelToolCalls?: boolean
}

/** `modelOptions` as apfel's request fields (`parallelToolCalls` aside: tool requests only). */
function nativeModelOptions(options: ApfelTextModelOptions | undefined) {
  const {
    maxCompletionTokens: limit,
    temperature,
    topP,
    seed,
    parallelToolCalls
  } = options ?? {}
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean")
    throw new TypeError("parallelToolCalls must be a boolean.")
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new RangeError(
      "maxCompletionTokens must be a nonnegative safe integer."
    )
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
    throw new RangeError(
      "reasoning.budgetTokens must be a nonnegative safe integer."
    )
  }
  if (
    request?.level !== undefined &&
    request.level !== "off" &&
    request.level !== "high"
  ) {
    throw new RangeError("Apfel emulated reasoning supports off or high.")
  }
  return { enabled: request?.level === "high", budget }
}

/** What a guided tool step decided: a tool and its arguments, or "answer". */
type Step = {
  action: string
  args: Record<string, unknown>
  usage?: OpenAIUsage | null
}

type DraftReasoning = {
  notes: string
  usage?: OpenAIUsage
  details?: ApfelProviderUsageDetails
}

/**
 * The draft's working notes, for the request that writes the step or the
 * answer: a user message of their own after the conversation, in the Prompt
 * API adapter's words.
 */
function withWorkingNotes(messages: Array<OpenAIMessage>, notes: string) {
  if (!notes) return messages
  return [
    ...messages,
    {
      role: "user" as const,
      content: `Working notes to verify against the conversation:\n${notes}\nNow produce the final response or required tool call.`
    }
  ]
}

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

/**
 * A chat message as apfel takes it. Tool calls and their results are
 * OpenAI's own messages, which apfel turns into the tool calls and outputs of
 * Apple's transcript, even in a request without tools.
 */
type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; tool_calls: Array<OpenAIToolCall> }
  | { role: "tool"; content: string; tool_call_id: string }

type OpenAIToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
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
function toolResultText(m: ModelMessage, name: string) {
  const text = contentText(m.content)
  if (m.error) return `${name} failed: ${m.error}`
  return text && text !== "null" ? text : "Nothing."
}

function contentText(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return (content ?? [])
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("")
}

/**
 * The conversation for apfel. Every step is kept, earlier turns' included, as
 * the Prompt API adapter does, but as OpenAI's tool messages rather than
 * text: apfel gives them to Apple's model as tool calls and outputs. Written
 * as text, a result read as the user's latest message (the draft then made
 * notes on its own instruction), and calls written as JSON taught the model
 * to answer in JSON, which it then copied in every later turn.
 */
function toOpenAIMessages(messages: Array<ModelMessage>): Array<OpenAIMessage> {
  const out: Array<OpenAIMessage> = []
  const names = new Map<string, string>()
  for (const m of messages) {
    const content = contentText(m.content)
    if (m.role === "tool") {
      const name = names.get(m.toolCallId ?? "") ?? "the tool"
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: toolResultText(m, name)
      })
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      for (const call of m.toolCalls) names.set(call.id, call.function.name)
      out.push({
        role: "assistant",
        content,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments || "{}"
          }
        }))
      })
    } else if (content) {
      out.push({ role: m.role === "user" ? "user" : "assistant", content })
    }
  }
  return out
}

/** The longest quote of the user's message the draft instruction carries. */
const QUOTE_CHARS = 500

/**
 * The draft's instruction, in the Prompt API adapter's words, quoting the
 * user's latest message: after a tool result, the newest user message is this
 * instruction itself, and Apple's model took it for the message to reply to.
 */
function draftInstruction(messages: ReadonlyArray<ModelMessage>): OpenAIMessage {
  const latest = [...messages].reverse().find((m) => m.role === "user")
  const text = latest ? contentText(latest.content).trim().replace(/\s+/g, " ") : ""
  const quote =
    text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text
  return {
    role: "user",
    content: `Now write notes for yourself before replying to the user's latest message${quote ? `, "${quote}"` : ""}: what's needed, what you already have, and what to do next. Don't call tools or write the reply yet.`
  }
}

/** Apple's model's context window: apfel's /v1/models reports 8,192 tokens. */
const CONTEXT_TOKENS = 8192
/** Room kept for the reply, out of the window. */
const REPLY_TOKENS = 1024

/**
 * A request's size in tokens, estimated: apfel has no way to measure it yet
 * (its #485), and Apple's tokenizer writes about 3 to 4 characters a token,
 * so 3 errs on the safe side.
 */
const estimateTokens = (messages: Array<OpenAIMessage>) =>
  messages.reduce(
    (n, m) =>
      n +
      Math.ceil(
        (m.content.length +
          ("tool_calls" in m ? JSON.stringify(m.tool_calls).length : 0)) /
          3
      ) +
      4,
    0
  )

/**
 * Whether a message starts one of the user's turns: a user message that
 * isn't the working notes or the draft's instruction (the adapter's own
 * messages, told apart by their fixed wording).
 */
const startsTurn = (m: OpenAIMessage) =>
  m.role === "user" &&
  !/^Working notes to verify against the conversation:|^Now write notes for yourself/.test(
    m.content
  )

/**
 * The messages without their oldest turn, as the Prompt API adapter leaves
 * turns out: the user's message and everything up to their next one, its
 * tool calls and results included. Undefined when only the current turn is
 * left (the system prompt and the current turn always stay).
 */
function withoutOldestTurn(messages: Array<OpenAIMessage>) {
  const starts = messages.flatMap((m, i) => (startsTurn(m) ? [i] : []))
  if (starts.length < 2) return undefined
  return [...messages.slice(0, starts[0]), ...messages.slice(starts[1])]
}

/**
 * apfel's fetch, fitting each request in Apple's context window as the
 * Prompt API adapter fits a conversation in Chrome's: the oldest turns are
 * left out until the estimate fits, and if apfel still answers that the
 * input exceeds the window, one more turn is left out and the request sent
 * again.
 */
function fitting(send: typeof fetch): typeof fetch {
  return async (url, init) => {
    if (typeof init?.body !== "string") return send(url, init)
    const body = JSON.parse(init.body) as { messages?: Array<OpenAIMessage> }
    if (!body.messages) return send(url, init)
    let messages = body.messages
    while (estimateTokens(messages) > CONTEXT_TOKENS - REPLY_TOKENS) {
      const fewer = withoutOldestTurn(messages)
      if (!fewer) break
      messages = fewer
    }
    for (;;) {
      const response = await send(url, {
        ...init,
        body: JSON.stringify({ ...body, messages })
      })
      if (response.status !== 400) return response
      const text = await response.clone().text()
      const fewer = /context window/i.test(text)
        ? withoutOldestTurn(messages)
        : undefined
      if (!fewer) return response
      messages = fewer
    }
  }
}

/** A tool's arguments in the subset apfel's guided generation takes, if it has any. */
function argumentsSchema(tool: Tool) {
  const schema = toGuidedSchema(tool.inputSchema)
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  return schema.type === "object" && Object.keys(properties).length > 0
    ? schema
    : undefined
}

/**
 * The decision's schema, as the Prompt API adapter's: "answer", or one of the
 * tools. `required` leaves answering out (`toolChoice: "required"`).
 */
function decisionSchema(toolNames: Array<string>, required: boolean) {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: required ? toolNames : ["answer", ...toolNames]
      }
    },
    required: ["action"]
  }
}

/** A value with its objects' keys sorted, at every depth. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])])
  )
}

/**
 * A tool call as a key to compare calls by: the same tool with the same
 * arguments is the same call, whatever order the model wrote the fields in.
 */
const callKey = (name: string, args: Record<string, unknown>) =>
  JSON.stringify([name, sortedKeys(args)])

/**
 * The tool calls already made since the user's latest message, as the Prompt
 * API adapter tracks them: small models sometimes call the tool they just
 * called, with the same arguments, instead of answering from its result.
 */
function currentTurnCalls(messages: ReadonlyArray<ModelMessage>) {
  const start = messages.map((m) => m.role).lastIndexOf("user")
  return new Set(
    messages
      .slice(start + 1)
      .flatMap((m) => m.toolCalls ?? [])
      .map((call) => {
        let args: unknown
        try {
          args = JSON.parse(call.function.arguments || "{}")
        } catch {
          args = {}
        }
        return callKey(
          call.function.name,
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {}
        )
      })
  )
}

/** A tool's description, to its first paragraph and at most 400 characters. */
function shortDescription(tool: Tool) {
  const first = (tool.description ?? "").trim().split(/\n\s*\n/)[0] ?? ""
  const line = first.replace(/\s+/g, " ")
  return line.length > 400 ? `${line.slice(0, 399)}…` : line
}

/**
 * The tools, as every request with tools lists them after the system prompt:
 * the same words as the Prompt API adapter's, so Apple's model and the
 * browser's read the same instructions.
 */
function toolsList(tools: Array<Tool>) {
  return [
    "You can use these tools:",
    ...tools.map((tool) => `- ${tool.name}: ${shortDescription(tool)}`),
    "Use a tool when the user asks for one or the answer needs current or outside information; otherwise answer directly. Once you have a tool's result, answer from it."
  ].join("\n")
}

/**
 * The system message with the tools listed after it, if there are any: what
 * the reasoning draft sees, so it can plan which tool to call, as the other
 * adapters' models do.
 */
function withToolsList(
  messages: Array<OpenAIMessage>,
  tools: Array<Tool>
): Array<OpenAIMessage> {
  if (tools.length === 0) return messages
  const [first, ...rest] = messages
  return first?.role === "system"
    ? [
        { role: "system", content: `${first.content}\n\n${toolsList(tools)}` },
        ...rest
      ]
    : [{ role: "system", content: toolsList(tools) }, ...messages]
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
  const completionTokens =
    usage.completion_tokens + (draft?.completion_tokens ?? 0)
  const result = buildBaseUsage<ApfelProviderUsageDetails>({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  })
  if (draft?.completion_tokens !== undefined) {
    result.completionTokensDetails = {
      reasoningTokens: draft.completion_tokens
    }
  }
  const cachedTokens =
    (usage.prompt_tokens_details?.cached_tokens ?? 0) +
    (draft?.prompt_tokens_details?.cached_tokens ?? 0)
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
function withSource(
  chunk: AdapterYieldChunk,
  source: ChunkSource
): AdapterYieldChunk {
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
const signalOf = (options: TextOptions<ApfelTextModelOptions>) =>
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

export class ApfelTextAdapter<TModel extends string> extends BaseTextAdapter<
  TModel,
  ApfelTextModelOptions,
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
  private readonly defaultHeaders: Record<string, string> | undefined
  private readonly onDownloadProgress: ((progress: number) => void) | undefined

  constructor(config: ApfelConfig, model: TModel) {
    super({}, model)
    this.baseURL = (config.baseURL ?? APFEL_BASE_URL).replace(/\/+$/, "")
    this.defaultHeaders = config.defaultHeaders
    this.headers = {
      ...config.defaultHeaders,
      "Content-Type": "application/json"
    }
    this.onDownloadProgress = config.onDownloadProgress
  }

  /**
   * "available" if apfel answers at `baseURL` and serves this model
   * (`GET /v1/models` lists it within 10 seconds), else "unavailable":
   * apfel isn't running, or (from a website) the browser didn't let the
   * page reach it. Apple's model never downloads through the page.
   */
  availability(): Promise<Availability> {
    return this.check()
  }

  /** `availability()`, with a caller's signal that also stops the request. */
  private async check(signal?: AbortSignal): Promise<Availability> {
    try {
      const timeout = AbortSignal.timeout(10_000)
      const response = await fetch(`${this.baseURL}/models`, {
        headers: { ...this.defaultHeaders },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      if (!response.ok) return "unavailable"
      const list = (await response.json()) as { data?: Array<{ id?: string }> }
      return list.data?.some((m) => m.id === this.model)
        ? "available"
        : "unavailable"
    } catch {
      return "unavailable"
    }
  }

  /**
   * Checks that apfel serves the model: resolves to this adapter (after
   * reporting 1, as nothing downloads) if it does, rejects if it doesn't
   * (fine to leave unawaited). Nothing loads, so `signal` only stops the
   * check: aborting it rejects at once with an AbortError, and reports
   * nothing.
   */
  create(
    options: {
      onDownloadProgress?: DownloadProgressCallback
      signal?: AbortSignal
    } = {}
  ): Promise<this> {
    const { onDownloadProgress } = options
    const { signal } = options
    const aborted = () =>
      new DOMException("The check was aborted.", "AbortError")
    const ready = new Promise<Availability>((resolve, reject) => {
      if (signal?.aborted) return reject(aborted())
      const onAbort = () => reject(aborted())
      signal?.addEventListener("abort", onAbort, { once: true })
      this.check(signal)
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", onAbort))
    }).then((availability) => {
      if (signal?.aborted) throw aborted()
      if (availability !== "available") {
        throw new Error(
          `apfel at ${this.baseURL} didn't answer, or doesn't serve ${this.model}.`
        )
      }
      this.onDownloadProgress?.(1)
      onDownloadProgress?.(1)
      return this
    })
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /** Nothing to free: apfel runs the model outside the page. */
  destroy(): Promise<void> {
    return Promise.resolve()
  }

  /** A separate, tool-free completion; its output never enters caller history. */
  private async *draftReasoning(
    options: TextOptions<ApfelTextModelOptions>,
    signal: AbortSignal | undefined,
    send: typeof fetch,
    budget: number | undefined,
    draft: DraftReasoning
  ): AsyncGenerator<AdapterYieldChunk> {
    signal?.throwIfAborted()
    const began = performance.now()
    const modelOptions = nativeModelOptions(options.modelOptions)
    // A thinking budget can narrow a caller's cap, but never raises it.
    const limit =
      budget === undefined
        ? modelOptions.max_tokens
        : modelOptions.max_tokens === undefined
          ? budget
          : Math.min(budget, modelOptions.max_tokens)
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
      options.logger.request(
        `activity=reasoning-draft provider=apfel model=${this.model} stream=true`,
        { provider: "apfel", model: this.model }
      )
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
            ...withToolsList(
              [
                ...systemMessages(options.systemPrompts),
                ...toOpenAIMessages(options.messages)
              ],
              options.toolChoice === "none" ? [] : (options.tools ?? [])
            ),
            draftInstruction(options.messages)
          ]
        }),
        signal: controller.signal
      })
      signal?.throwIfAborted()
      if (!response.ok || !response.body) {
        throw new Error(
          `apfel returned HTTP ${response.status}: ${await errorBody(response)}`
        )
      }
      for await (const data of sseData(response.body)) {
        signal?.throwIfAborted()
        if (data === "[DONE]") break
        const chunk = JSON.parse(data) as OpenAIChunk
        if (chunk.error)
          throw new Error(chunk.error.message ?? "apfel sent an error.")
        draft.usage = chunk.usage ?? draft.usage
        const choice = chunk.choices?.[0]
        finish = choice?.finish_reason ?? finish
        const delta = choice?.delta?.content ?? choice?.delta?.reasoning_content
        if (!delta) continue
        if (!opened) {
          opened = true
          yield {
            ...event,
            type: EventType.REASONING_START,
            timestamp: Date.now()
          }
          yield {
            ...event,
            type: EventType.REASONING_MESSAGE_START,
            role: "reasoning",
            timestamp: Date.now()
          }
        }
        draft.notes += delta
        yield {
          ...event,
          type: EventType.REASONING_MESSAGE_CONTENT,
          delta,
          timestamp: Date.now()
        }
      }
      signal?.throwIfAborted()
      draft.details.thinkingTokens = draft.usage?.completion_tokens
      // Use the server's finish reason: its usage accounting can include tokens
      // beyond the configured generation cap, so count comparisons are unreliable.
      draft.details.thinkingBudgetExhausted =
        budget !== undefined && finish === "length" && limit === budget
      draft.details.reasoningMs = performance.now() - began
      if (opened) {
        yield {
          ...event,
          type: EventType.REASONING_MESSAGE_END,
          timestamp: Date.now()
        }
        yield { ...event, type: EventType.REASONING_END, timestamp: Date.now() }
      }
    } finally {
      signal?.removeEventListener("abort", cancel)
      // Close only the draft transport, including when a consumer leaves early.
      controller.abort()
    }
  }

  async *chatStream(
    options: TextOptions<ApfelTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.model)
    for await (const chunk of this.chatStreamRequest(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *chatStreamRequest(
    options: TextOptions<ApfelTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const emulation = reasoningOptions(options.reasoning)
    // Invalid options throw here, before the run starts.
    const sampling = nativeModelOptions(options.modelOptions)
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

    const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
    const send = fitting(options.wrapFetch ? options.wrapFetch(fetch) : fetch)
    const url = `${this.baseURL}/chat/completions`
    logger.request(
      `activity=chat provider=apfel model=${model} messages=${options.messages.length} tools=${tools.length} stream=true`,
      { provider: "apfel", model }
    )
    const draft: DraftReasoning = { notes: "" }
    try {
      if (emulation.enabled)
        yield* this.draftReasoning(
          options,
          signal,
          send,
          emulation.budget,
          draft
        )
    } catch (error) {
      if (signal?.aborted) return
      yield runError(`apfel's reasoning draft failed: ${errorText(error)}`)
      return
    }
    // Every request with tools lists them after the system prompt, the step
    // and the answer alike, as the Prompt API adapter's session does.
    const conversation = withWorkingNotes(
      withToolsList(
        [
          ...systemMessages(options.systemPrompts),
          ...toOpenAIMessages(options.messages)
        ],
        tools
      ),
      draft.notes
    )

    // With tools, a guided step comes first: one request in which the model
    // picks a tool and writes its arguments, or picks "answer". A tool call
    // ends the step there; an answer is then written, streamed, below.
    let stepMs: number | undefined
    if (tools.length > 0) {
      const stepStart = performance.now()
      let step: Step
      try {
        step = await this.decideStep(tools, options, conversation, send, signal)
      } catch (error) {
        if (signal?.aborted) return
        logger.errors("apfel tool step failed", {
          error,
          source: "apfel.chatStream"
        })
        yield runError(`apfel's tool step failed: ${errorText(error)}`)
        return
      }
      stepMs = performance.now() - stepStart
      if (step.action !== "answer") {
        const toolCallId = nextId("tool")
        const args = JSON.stringify(step.args)
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: step.action,
          parentMessageId: messageId,
          index: 0,
          model,
          timestamp: timestamp()
        }
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
          toolCallName: step.action,
          args,
          input: step.args,
          model,
          timestamp: timestamp()
        }
        const details: ApfelProviderUsageDetails = {
          ...draft.details,
          toolStepMs: stepMs
        }
        const finishUsage = usageOf(step.usage, details, draft.usage)
        yield {
          type: EventType.RUN_FINISHED,
          runId,
          threadId,
          model,
          timestamp: timestamp(),
          finishReason: "tool_calls",
          ...(finishUsage && { usage: finishUsage })
        }
        return
      }
    }

    const sentAt = performance.now()
    let response: Response
    try {
      signal?.throwIfAborted()
      response = await send(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...sampling,
          model,
          stream: true,
          // Token counts, for the stats.
          stream_options: { include_usage: true },
          messages: conversation
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
    // reasoning events, then the answer as text.
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
          (delta?.reasoning_content?.length ?? 0)
        if (chars > 0) {
          timing.last = performance.now()
          if (!timing.first) {
            timing.first = timing.last
            timing.firstChars = chars
          }
          timing.chars += chars
        }
        if (delta?.reasoning_content) addReasoning(delta.reasoning_content)
        if (delta?.content) addText(delta.content)
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
              (outputTokens * (timing.chars - timing.firstChars)) / timing.chars
          })
        }
      : {}
    endReasoning()
    endText()
    yield* events.splice(0)

    Object.assign(details, draft.details)
    if (stepMs !== undefined) details.toolStepMs = stepMs
    const finishUsage = usageOf(usage, details, draft.usage)
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason:
        finishReason === "tool_calls" || finishReason === null
          ? "stop"
          : finishReason,
      ...(finishUsage && { usage: finishUsage })
    }
  }

  /**
   * The guided tool step, as the Prompt API adapter's: first the decision,
   * "answer" or a tool, then that tool's arguments, each a request held to
   * its schema by apfel's guided generation. Neither adds instructions of its
   * own: the conversation lists the tools, and the schema says what to write.
   * A named `toolChoice`, or `required` with one tool, skips the decision.
   */
  private async decideStep(
    tools: Array<Tool>,
    options: TextOptions<ApfelTextModelOptions>,
    conversation: Array<OpenAIMessage>,
    send: typeof fetch,
    signal: AbortSignal | undefined
  ): Promise<Step> {
    // The output cap is the answer's: these are short JSON replies of their
    // own (an undefined field is left out of the request body).
    const sampling = {
      ...nativeModelOptions(options.modelOptions),
      max_tokens: undefined
    }
    const usages: Array<OpenAIUsage> = []
    const guided = async (name: string, schema: object) => {
      options.logger.request(
        `activity=tool-step provider=apfel model=${this.model} step=${name}`,
        { provider: "apfel", model: this.model }
      )
      const response = await send(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          ...sampling,
          model: this.model,
          messages: conversation,
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
      if (completion.usage) usages.push(completion.usage)
      const text = (completion.choices?.[0]?.message?.content ?? "")
        .trim()
        .replace(/^```(?:json)?\s*|\s*```$/g, "")
      try {
        return JSON.parse(text) as unknown
      } catch {
        return undefined
      }
    }
    // A step that needed no request (a named tool, or "required" with one
    // tool and no arguments) counts as none, so the draft's usage still shows.
    const usage = () =>
      usages.reduce(
        (sum, u) => ({
          prompt_tokens: (sum.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
          completion_tokens:
            (sum.completion_tokens ?? 0) + (u.completion_tokens ?? 0)
        }),
        { prompt_tokens: 0, completion_tokens: 0 } as OpenAIUsage
      )

    const names = tools.map((tool) => tool.name)
    const choice = options.toolChoice
    let action: string | undefined
    if (typeof choice === "object" && names.includes(choice.name)) {
      action = choice.name
    } else if (choice === "required" && tools.length === 1) {
      action = names[0]
    } else {
      const decision = await guided(
        "decision",
        decisionSchema(names, choice === "required")
      )
      const picked =
        decision && typeof decision === "object" && "action" in decision
          ? decision.action
          : undefined
      action = typeof picked === "string" ? picked : undefined
    }
    const tool = tools.find((t) => t.name === action)
    if (!tool) return { action: "answer", args: {}, usage: usage() }

    const schema = argumentsSchema(tool)
    const written = schema ? await guided(tool.name, schema) : {}
    const args =
      written && typeof written === "object" && !Array.isArray(written)
        ? (withoutNulls(written, schema ?? {}) as Record<string, unknown>)
        : {}
    // A repeat of a call already made this turn: answer from its result.
    if (currentTurnCalls(options.messages).has(callKey(tool.name, args))) {
      return { action: "answer", args: {}, usage: usage() }
    }
    return { action: tool.name, args, usage: usage() }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`, from apfel's JSON mode:
   * `response_format: json_schema` constrains Apple's model to the schema
   * (guided generation). `chat()` validates the result. One request, not
   * streamed; the streamed form is `structuredOutputStream`.
   */
  async structuredOutput(
    options: StructuredOutputOptions<ApfelTextModelOptions>
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
    options: StructuredOutputOptions<ApfelTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.chatOptions.model)
    for await (const chunk of this.structuredOutputRequestStream(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *structuredOutputRequestStream(
    options: StructuredOutputOptions<ApfelTextModelOptions>
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
    options: StructuredOutputOptions<ApfelTextModelOptions>,
    stream: boolean,
    messageId = nextId("msg")
  ): AsyncGenerator<AdapterYieldChunk, StructuredRunResult> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    signal?.throwIfAborted()
    const emulation = reasoningOptions(chatOptions.reasoning)
    const model = this.model
    const send = fitting(
      chatOptions.wrapFetch ? chatOptions.wrapFetch(fetch) : fetch
    )
    chatOptions.logger.request(
      `activity=${stream ? "structuredOutputStream" : "structuredOutput"} provider=apfel model=${model} messages=${chatOptions.messages.length} tools=0 stream=${stream}`,
      { provider: "apfel", model }
    )
    const draft: DraftReasoning = { notes: "" }
    if (emulation.enabled) {
      yield* this.draftReasoning(
        chatOptions,
        signal,
        send,
        emulation.budget,
        draft
      )
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
          messages: withWorkingNotes(
            [
              ...systemMessages(chatOptions.systemPrompts),
              ...toOpenAIMessages(chatOptions.messages)
            ],
            draft.notes
          ),
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
      yield {
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningId,
        model,
        timestamp: Date.now()
      }
      yield {
        type: EventType.REASONING_END,
        messageId: reasoningId,
        model,
        timestamp: Date.now()
      }
      reasoningId = undefined
    }
    const addText = function* (delta: string): Generator<AdapterYieldChunk> {
      if (!delta) return
      yield* endReasoning()
      if (!textStarted) {
        textStarted = true
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          model,
          timestamp: Date.now()
        }
      }
      content += delta
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta,
        content,
        model,
        timestamp: Date.now()
      }
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
        if (chunk.error)
          throw new Error(chunk.error.message ?? "apfel sent an error.")
        usage = chunk.usage ?? usage
        const choice = chunk.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (delta?.reasoning_content) {
          if (!reasoningId) {
            reasoningId = nextId("reasoning")
            yield {
              type: EventType.REASONING_START,
              messageId: reasoningId,
              model,
              timestamp: Date.now()
            }
            yield {
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningId,
              role: "reasoning",
              model,
              timestamp: Date.now()
            }
          }
          nativeReasoning += delta.reasoning_content
          yield {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoningId,
            delta: delta.reasoning_content,
            model,
            timestamp: Date.now()
          }
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
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: Date.now()
      }
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
        : new StructuredOutputFailure(
            "apfel's answer is empty.",
            "empty-response"
          )
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
 *   adapter: apfelText("apple-foundationmodel"),
 *   messages,
 *   threadId
 * })
 * ```
 */
export function apfelText<TModel extends ApfelTextModel>(
  model: TModel,
  config: ApfelConfig = {}
): ApfelTextAdapter<TModel> {
  return new ApfelTextAdapter(config, model)
}
