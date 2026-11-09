/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel's OpenAI-compatible server on the user's Mac. Each `chatStream`
 * call is one streamed Chat Completions request. Tools work as in the Prompt
 * API adapter (see `tools.ts`): listed in the system prompt, called in a
 * ```tool_call fence the adapter reads from the text, and repaired with a
 * schema-held request when a call is invalid. Structured output is
 * `response_format: json_schema`.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type {
  AdapterYieldChunk,
  ModelMessage,
  TextOptions,
  TokenUsage,
  Tool
} from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type {
  StructuredOutputOptions,
  StructuredOutputResult
} from "@tanstack/ai/adapters"

import type { ApfelChatModel } from "./model-meta.js"
import {
  repairPrompt,
  repairToolCall,
  toolCallError,
  toolCallFence,
  toolCallReader,
  toolResultFence,
  toolResultLine,
  toolSystemPrompt
} from "./tools.js"

/** A model apfel serves: a listed one, or any other id apfel lists. */
export type ApfelTextModel = ApfelChatModel | (string & {})

export type ApfelConfig = {
  /** apfel's OpenAI-compatible API, up to `/v1`. `http://127.0.0.1:11434/v1` by default. */
  baseURL?: string
  /** Headers sent with every request, such as apfel's bearer token. */
  defaultHeaders?: Record<string, string>
}

/** The Prompt API's availability values; apfel's model is "available" or "unavailable". */
export type Availability =
  "unavailable" | "downloadable" | "downloading" | "available"

/** Timings of one model call in ms, in `usage.providerUsageDetails`. */
export type ApfelProviderUsageDetails = {
  /** From sending the request to the first text. */
  firstTokenMs?: number
  /** From the first text to the last. */
  decodeMs?: number
  /** Tokens after the first chunk, estimated from the first chunk's share of the characters. */
  decodeTokens?: number
}

/** Per-call `modelOptions`, with the OpenRouter adapter's names. */
export type ApfelTextModelOptions = {
  /** Sent as `max_tokens`. */
  maxCompletionTokens?: number
  temperature?: number
  /** Sent as `top_p`. */
  topP?: number
  seed?: number
}

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

type Message = { role: "system" | "user" | "assistant"; content: string }

type OpenAIUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

type OpenAIChunk = {
  choices?: Array<{ delta?: { content?: string | null } }>
  usage?: OpenAIUsage | null
  error?: { message?: string }
}

const text = (content: ModelMessage["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((p) => (p.type === "text" ? p.content : "")).join("")

/**
 * The system prompt (with the tools, if any) and the conversation, as the
 * Prompt API adapter writes them: tool calls as ```tool_call fences after the
 * model's text, and a step's tool results as one user message in a
 * ```tool_result fence.
 */
function toMessages(
  options: TextOptions<ApfelTextModelOptions>,
  tools: ReadonlyArray<Tool>
): Array<Message> {
  const system = toolSystemPrompt(
    normalizeSystemPrompts(options.systemPrompts)
      .map((p) => p.content)
      .join("\n\n"),
    tools
  )
  const out: Array<Message> = system
    ? [{ role: "system", content: system }]
    : []
  const toolNames = new Map<string, string>()
  let results: Array<string> | undefined
  for (const m of options.messages) {
    if (m.role === "tool") {
      const id = m.toolCallId ?? ""
      const line = toolResultLine(
        id,
        toolNames.get(id) ?? "tool",
        text(m.content),
        m.error
      )
      if (results) {
        results.push(line)
        out[out.length - 1] = {
          role: "user",
          content: toolResultFence(results)
        }
      } else {
        results = [line]
        out.push({ role: "user", content: toolResultFence(results) })
      }
      continue
    }
    results = undefined
    for (const call of m.toolCalls ?? [])
      toolNames.set(call.id, call.function.name)
    const content = [
      text(m.content),
      ...(m.toolCalls?.length ? [toolCallFence(m.toolCalls)] : [])
    ]
      .filter(Boolean)
      .join("\n")
    if (content) {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content })
    }
  }
  return out
}

/** Sampling options as apfel's request fields. */
function sampling(options: TextOptions<ApfelTextModelOptions>) {
  const { maxCompletionTokens, temperature, topP, seed } =
    options.modelOptions ?? {}
  return {
    ...(maxCompletionTokens !== undefined && {
      max_tokens: maxCompletionTokens
    }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { top_p: topP }),
    ...(seed !== undefined && { seed })
  }
}

/** apfel rejects these with HTTP 400: guided generation can't enforce them. */
const UNENFORCEABLE = [
  "minLength",
  "maxLength",
  "pattern",
  "uniqueItems",
  "multipleOf",
  "not"
]

/**
 * A schema apfel's guided generation takes: what it can't enforce is left
 * out, `oneOf` is read as `anyOf`, and `allOf` parts are merged.
 */
function guidedSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(guidedSchema)
  if (!schema || typeof schema !== "object") return schema
  let node = schema as Record<string, unknown>
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node
    node = Object.assign({}, rest, ...(allOf as Array<object>))
  }
  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) =>
      UNENFORCEABLE.includes(key) ||
      (key === "additionalProperties" && typeof value === "object")
        ? []
        : [[key === "oneOf" ? "anyOf" : key, guidedSchema(value)]]
    )
  )
}

function usageOf(
  usage: OpenAIUsage | null | undefined,
  details?: ApfelProviderUsageDetails
): TokenUsage | undefined {
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } =
    usage ?? {}
  if (promptTokens === undefined || completionTokens === undefined) return
  const result = buildBaseUsage<ApfelProviderUsageDetails>({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  })
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens
  if (cachedTokens) result.promptTokensDetails = { cachedTokens }
  if (details) result.providerUsageDetails = details
  return result
}

/** The parsed `data:` payloads of an SSE body, up to `[DONE]`. */
async function* sse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ""
  // A reader, not `for await`: Safari's streams aren't async iterable.
  const reader = body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") return
      const chunk = JSON.parse(data) as OpenAIChunk
      if (chunk.error)
        throw new Error(chunk.error.message ?? "apfel sent an error.")
      yield chunk
    }
  }
}

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions<ApfelTextModelOptions>) =>
  options.abortController?.signal ??
  (options.request as RequestInit | undefined)?.signal ??
  undefined

let ids = 0
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${ids++}`

export class ApfelTextAdapter<TModel extends string> extends BaseTextAdapter<
  TModel,
  ApfelTextModelOptions,
  readonly ["text"],
  MetadataByModality
> {
  readonly name = "apfel" as const
  override readonly provider = "apfel" as const
  override readonly api = "openai-completions" as const
  override readonly inputModalities = ["text"] as const
  private readonly baseURL: string
  private readonly defaultHeaders: Record<string, string>

  constructor(config: ApfelConfig, model: TModel) {
    super({}, model)
    this.baseURL = (config.baseURL ?? "http://127.0.0.1:11434/v1").replace(
      /\/+$/,
      ""
    )
    this.defaultHeaders = config.defaultHeaders ?? {}
  }

  /** "available" if apfel lists the model within 10 seconds, else "unavailable". */
  async availability(signal?: AbortSignal): Promise<Availability> {
    try {
      const timeout = AbortSignal.timeout(10_000)
      const response = await fetch(`${this.baseURL}/models`, {
        headers: this.defaultHeaders,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      const list = (await response.json()) as { data?: Array<{ id?: string }> }
      return response.ok && list.data?.some((m) => m.id === this.model)
        ? "available"
        : "unavailable"
    } catch {
      return "unavailable"
    }
  }

  /** Resolves to this adapter if apfel serves the model, else rejects. Nothing loads. */
  async create({ signal }: { signal?: AbortSignal } = {}): Promise<this> {
    signal?.throwIfAborted()
    const availability = await this.availability(signal)
    signal?.throwIfAborted()
    if (availability !== "available")
      throw new Error(
        `apfel at ${this.baseURL} didn't answer, or doesn't serve ${this.model}.`
      )
    return this
  }

  /** One Chat Completions request; an HTTP error throws. */
  private async post(
    options: TextOptions<ApfelTextModelOptions>,
    body: object,
    signal = signalOf(options)
  ): Promise<Response> {
    const send = options.wrapFetch?.(fetch) ?? fetch
    const response = await send(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: { ...this.defaultHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        ...sampling(options),
        ...body
      }),
      signal
    })
    if (!response.ok) {
      const raw = await response.text()
      let message = raw.slice(0, 200)
      try {
        message = (JSON.parse(raw) as OpenAIChunk).error?.message ?? message
      } catch {
        // Not JSON: keep the raw body.
      }
      throw new Error(`apfel returned HTTP ${response.status}: ${message}`)
    }
    return response
  }

  /** A JSON answer held to `schema` by apfel's guided generation. */
  private async generateJson(
    options: TextOptions<ApfelTextModelOptions>,
    messages: Array<Message>,
    schema: unknown
  ) {
    const signal = signalOf(options)
    signal?.throwIfAborted()
    const response = await this.post(options, {
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", schema }
      }
    })
    const completion = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null }
        finish_reason?: string
      }>
      usage?: OpenAIUsage | null
    }
    signal?.throwIfAborted()
    const choice = completion.choices?.[0]
    if (choice?.finish_reason === "length")
      throw new Error(
        "apfel's answer was cut off at the token limit before its JSON ended; raise modelOptions.maxCompletionTokens."
      )
    const rawText = choice?.message?.content?.trim() ?? ""
    const usage = usageOf(completion.usage)
    return {
      data: JSON.parse(rawText) as unknown,
      rawText,
      ...(usage && { usage })
    }
  }

  async *chatStream(
    options: TextOptions<ApfelTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const model = this.model
    const runId = options.runId ?? nextId("run")
    const { threadId } = options
    const messageId = nextId("msg")
    const signal = signalOf(options)
    // `toolChoice: "required"` or a named tool works as "auto".
    const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: Date.now()
    }

    let content = ""
    const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
      if (!delta) return
      if (!content) {
        timing.first = performance.now()
        timing.firstChars = delta.length
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          model,
          timestamp: Date.now()
        }
      }
      timing.last = performance.now()
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
    const reader = toolCallReader()
    let usage: OpenAIUsage | null | undefined
    const timing = { sent: performance.now(), first: 0, last: 0, firstChars: 0 }
    // Stops apfel once the reply's tool call is read.
    const stop = new AbortController()
    const messages = toMessages(options, tools)
    let call = undefined as typeof reader.call
    try {
      try {
        const response = await this.post(
          options,
          {
            messages,
            stream: true,
            stream_options: { include_usage: true }
          },
          signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
        )
        for await (const chunk of sse(
          response.body as ReadableStream<Uint8Array>
        )) {
          usage = chunk.usage ?? usage
          yield* textEvents(
            reader.push(chunk.choices?.[0]?.delta?.content ?? "")
          )
          if (reader.fence !== undefined) {
            stop.abort()
            break
          }
        }
      } catch (error) {
        if (!stop.signal.aborted || signal?.aborted) throw error
      }
      yield* textEvents(reader.end())

      call = reader.call
      const fence = reader.fence
      const reason =
        fence === undefined ? undefined : toolCallError(call, tools)
      if (fence !== undefined && reason !== undefined) {
        // One repair, held to the schema; if it fails too, the fence is text.
        const attempt: Array<Message> = [
          ...messages,
          { role: "assistant", content: content + fence },
          { role: "user", content: repairPrompt(reason) }
        ]
        call = await repairToolCall(
          tools,
          call?.name,
          async (schema) =>
            (await this.generateJson(options, attempt, guidedSchema(schema)))
              .data
        )
        signal?.throwIfAborted()
        if (!call) yield* textEvents(fence)
      }
      // Text after the call, in the piece that closed it, is shown too.
      yield* textEvents(reader.trailing)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: Date.now(),
        message,
        error: { message }
      }
      return
    }
    if (content)
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: Date.now()
      }

    if (call) {
      const toolCallId = nextId("call")
      const args = JSON.stringify(call.arguments)
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: call.name,
        parentMessageId: messageId,
        index: 0,
        model,
        timestamp: Date.now()
      }
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: args,
        args,
        model,
        timestamp: Date.now()
      }
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId,
        toolCallName: call.name,
        args,
        input: call.arguments,
        model,
        timestamp: Date.now()
      }
    }

    // apfel sends usage at the end of a reply: a reply stopped at its tool call has none.
    const outputTokens = usage?.completion_tokens
    const finishUsage = usageOf(
      usage,
      content
        ? {
            firstTokenMs: timing.first - timing.sent,
            decodeMs: timing.last - timing.first,
            ...(outputTokens !== undefined && {
              decodeTokens:
                (outputTokens * (content.length - timing.firstChars)) /
                content.length
            })
          }
        : undefined
    )
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: Date.now(),
      finishReason: call ? "tool_calls" : "stop",
      ...(finishUsage && { usage: finishUsage })
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`, held to the schema (as
   * given) by apfel's guided generation. `chat()` validates it, and streams
   * it too.
   */
  async structuredOutput(
    options: StructuredOutputOptions<ApfelTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    return this.generateJson(
      chatOptions,
      toMessages(chatOptions, []),
      outputSchema
    )
  }
}

/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel: `chat({ adapter: apfelText("apple-foundationmodel"), messages, threadId })`.
 */
export function apfelText<TModel extends ApfelTextModel>(
  model: TModel,
  config: ApfelConfig = {}
): ApfelTextAdapter<TModel> {
  return new ApfelTextAdapter(config, model)
}
