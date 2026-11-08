/**
 * A TanStack AI text adapter for webgllm: LFM3, LFM2.5 and Qwen3.5 on
 * WebGL 2 in a Web Worker, for browsers without WebGPU. Hand it to `chat()`
 * like any hosted model's adapter: `chat()` runs tools and the agent loop,
 * and each `chatStream` call here is one streamed Chat Completions request
 * to the shared `WebGLLM` instance, mapped to AG-UI events.
 *
 * webgllm itself parses tool calls, splits thinking from the answer,
 * repairs bad calls, constrains forced calls and JSON answers to their
 * schemas: this file only translates between the two APIs.
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
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"
import { WebGLLMError } from "webgllm"
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
  CompletionTimings,
  CompletionUsage,
  FinishReason
} from "webgllm"

import { modelMeta } from "./catalog.js"
import type { WebGllmModelReasoningByName, WebGllmChatModel } from "./catalog.js"
import { availability, ensureModel, loadModel, setKeepLoaded, touchModel, unloadModel, webgllm } from "./models.js"
import type { Availability, DownloadProgressCallback } from "./models.js"

/**
 * Per-call `modelOptions`: sampling over the model card's, and the most
 * tokens to generate. Named like TanStack's OpenRouter adapter's (the
 * OpenRouter SDK's camelCase request fields), so the same `modelOptions`
 * work with either adapter; webgllm's own extensions follow the same casing.
 */
export type WebGllmTextModelOptions = {
  /** Maximum generated tokens, thinking included; otherwise EOS or remaining context. */
  maxCompletionTokens?: number
  temperature?: number
  topP?: number
  presencePenalty?: number
  /** Not supported by webgllm: anything but 0 throws its `unsupported-parameter` error. */
  frequencyPenalty?: number
  /** Text that ends the reply where it appears (not included). */
  stop?: string | Array<string>
  /** Makes sampling repeatable. */
  seed?: number
  /** False keeps only the first tool call of a reply. */
  parallelToolCalls?: boolean
  /** webgllm: samples from the k likeliest tokens. */
  topK?: number
  /** webgllm: drops tokens less likely than this fraction of the likeliest. */
  minP?: number
  /** webgllm: penalizes tokens already in the chat. */
  repetitionPenalty?: number
  /** webgllm: false returns tool calls as the model wrote them, without its repair. Default true. */
  repairToolCalls?: boolean
}

/** Timings of one model call, in `RUN_FINISHED`'s `usage.providerUsageDetails` (webgllm's `timings`). */
export type WebGllmProviderUsageDetails = {
  /** From the request reaching the worker to the first generated token, reading the prompt included. */
  firstTokenMs?: number
  /** Reading the part of the prompt that wasn't cached, in milliseconds. */
  promptMs?: number
  /** From the first generated token to the last, in milliseconds. */
  decodeMs?: number
  promptTokensPerSecond?: number
  decodeTokensPerSecond?: number
}

/** Options for `webgllmText`. */
export type WebGllmConfig = {
  /**
   * Most tokens a chat may hold, prompt and reply together: the model's
   * whole context length by default, never more. A smaller limit takes less
   * memory and refuses longer chats sooner. Changing it loads the model again.
   */
  contextLength?: number
  /**
   * Keeps the model loaded when another model (of webgllm, Transformers.js
   * or wllama) loads past the page's memory budget (see `setMemoryBudget`);
   * by default the least recently used model is unloaded to make room.
   */
  keepLoaded?: boolean
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `createSessionWithProgress`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

type ResolveReasoning<TModel extends string> = TModel extends keyof WebGllmModelReasoningByName
  ? WebGllmModelReasoningByName[TModel]
  : never

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

/**
 * `reasoning_effort` and `thinking_budget_tokens` for a TanStack reasoning
 * request: the level clamped to the model's (the template's enable_thinking),
 * and a thinking cap only when one was asked for.
 */
function reasoningFields(
  request: ReasoningRequest | undefined,
  model: WebGllmChatModel
): Pick<ChatCompletionCreateParamsStreaming, "reasoning_effort" | "thinking_budget_tokens"> {
  const budget = request?.budgetTokens
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new RangeError("reasoning.budgetTokens must be a non-negative safe integer.")
  }
  const capability = modelMeta(model).reasoning
  const resolved = resolveReasoning(request, capability)
  const thinking = resolved === undefined ? undefined : resolved.value === "true"
  const effort = thinking === undefined ? {} : { reasoning_effort: thinking ? ("high" as const) : ("none" as const) }
  // String levels and omitted budgets keep unlimited thinking; off ignores a valid cap.
  if (budget === undefined || thinking === false) return effort
  if (!capability?.budget || !resolved) throw new Error(`${model} does not support a thinking token budget.`)
  return { ...effort, ...(resolved.budgetTokens !== undefined && { thinking_budget_tokens: resolved.budgetTokens }) }
}

/** A caller's output cap, without a provider-wide default. */
function outputTokens(options: WebGllmTextModelOptions | undefined) {
  const limit = options?.maxCompletionTokens
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError("maxCompletionTokens must be a nonnegative safe integer.")
  }
  return limit
}

/** `modelOptions` as webgllm's sampling fields. */
function samplingFields(o: WebGllmTextModelOptions | undefined): Partial<ChatCompletionCreateParamsStreaming> {
  if ((o?.frequencyPenalty ?? 0) !== 0) {
    throw new WebGLLMError(
      "unsupported-parameter",
      "frequencyPenalty isn't supported; presencePenalty and repetitionPenalty are."
    )
  }
  const maxTokens = outputTokens(o)
  const fields: Partial<ChatCompletionCreateParamsStreaming> = {
    max_completion_tokens: maxTokens,
    temperature: o?.temperature,
    top_p: o?.topP,
    top_k: o?.topK,
    min_p: o?.minP,
    repetition_penalty: o?.repetitionPenalty,
    presence_penalty: o?.presencePenalty,
    stop: o?.stop,
    seed: o?.seed
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

function contentText(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return (content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("")
}

/**
 * The conversation as OpenAI messages: system prompts first, then each
 * message with its tool calls, results (a failed tool's error as its
 * result) and thinking. webgllm decides what the template sees of them.
 */
function toMessages(
  systemPrompts: TextOptions["systemPrompts"],
  messages: Array<ModelMessage>
): Array<ChatCompletionMessageParam> {
  const system = normalizeSystemPrompts(systemPrompts)
    .map((p) => p.content)
    .join("\n\n")
  const out: Array<ChatCompletionMessageParam> = system ? [{ role: "system", content: system }] : []
  for (const m of messages) {
    const text = contentText(m.content)
    if (m.role === "tool") {
      out.push({
        role: "tool",
        content: m.error ? `Error: ${m.error}` : text,
        tool_call_id: m.toolCallId ?? ""
      })
    } else if (m.role === "user") {
      out.push({ role: "user", content: text })
    } else {
      const thinking = m.thinking?.map((t) => t.content).join("")
      out.push({
        role: "assistant",
        content: text,
        ...(thinking && { reasoning_content: thinking }),
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.function.name, arguments: call.function.arguments }
          }))
        })
      })
    }
  }
  return out
}

/** Tools as OpenAI functions. */
function toTools(tools: Array<Tool> | undefined): Array<ChatCompletionTool> {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      ...(tool.inputSchema !== undefined && { parameters: tool.inputSchema as Record<string, unknown> })
    }
  }))
}

function toToolChoice(choice: TextOptions["toolChoice"]): ChatCompletionToolChoiceOption | undefined {
  if (choice === undefined || typeof choice === "string") return choice
  return { type: "function", function: { name: choice.name } }
}

function usageOf(usage: CompletionUsage, timings: CompletionTimings | undefined): TokenUsage {
  const result = buildBaseUsage<WebGllmProviderUsageDetails>({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  })
  const cached = usage.prompt_tokens_details.cached_tokens
  if (cached > 0) result.promptTokensDetails = { cachedTokens: cached }
  const reasoning = usage.completion_tokens_details.reasoning_tokens
  if (reasoning > 0) result.completionTokensDetails = { reasoningTokens: reasoning }
  if (timings) {
    result.providerUsageDetails = {
      ...(timings.first_token_ms !== null && { firstTokenMs: timings.first_token_ms }),
      promptMs: timings.prompt_ms,
      decodeMs: timings.decode_ms,
      promptTokensPerSecond: timings.prompt_tokens_per_second,
      decodeTokensPerSecond: timings.decode_tokens_per_second
    }
  }
  return result
}

const isAbort = (error: unknown, signal: AbortSignal | undefined) =>
  !!signal?.aborted || (error instanceof DOMException && error.name === "AbortError")

/** Codes for failures loading the model rather than generating. */
const LOAD_CODES = new Set(["webgl2-unavailable", "download-failed", "storage-full"])

/** A RUN_ERROR for a failure: webgllm's code as the event's code and error type. */
function runError(model: string, error: unknown, loading: boolean): AdapterYieldChunk {
  const text = error instanceof Error ? error.message : String(error)
  const code = error instanceof WebGLLMError ? error.code : undefined
  const message = loading || (code && LOAD_CODES.has(code)) ? `Couldn't load ${model}: ${text}` : text
  return {
    type: EventType.RUN_ERROR,
    model,
    timestamp: Date.now(),
    message,
    ...(code && { code, errorType: code }),
    error: { message, ...(code && { code }) }
  }
}

let calls = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(calls++).toString(36)}`

const signalOf = (options: TextOptions<WebGllmTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class WebGllmTextAdapter<TModel extends WebGllmChatModel> extends BaseTextAdapter<
  TModel,
  WebGllmTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ResolveReasoning<TModel>
> {
  override readonly kind = "text" as const
  readonly name = "webgllm" as const
  override readonly api = "webgllm" as const
  override readonly inputModalities = ["text"] as const

  private readonly contextLength: number | undefined
  private readonly onDownloadProgress: DownloadProgressCallback | undefined

  constructor(config: WebGllmConfig, model: TModel) {
    super({}, model)
    this.contextLength = config.contextLength
    this.onDownloadProgress = config.onDownloadProgress
    setKeepLoaded(model, config.keepLoaded ?? false)
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where the engine can't run (WebGL 2 with float render
   * targets, in a worker; not on a server; checked once per page),
   * "available" when it's loaded for this adapter's `contextLength` and
   * ready in this page (by any adapter of it), else "downloadable",
   * even while it loads or when its files are in webgllm's storage (a load
   * then reads them). It never says "downloading": progress comes from
   * `createSessionWithProgress`. It reads no storage and makes no request.
   */
  availability(): Promise<Availability> {
    return availability(this.model, this.contextLength)
  }

  /**
   * Loads the model for this adapter's `contextLength` (downloading it the
   * first time), with the download's progress, 0 to 1, then 1 once it's
   * ready. Resolves to this adapter when it's ready; rejects if it can't
   * load (fine to leave unawaited). `chat()` doesn't need it (its first call
   * loads the model), but it lets a page load ahead of time. Adapters for
   * the same model share one loaded model; other models stay loaded while
   * they fit the memory budget. Aborting `signal` rejects this call at once
   * with an AbortError and stops its progress reports; if no other caller
   * (another call, or a chat waiting for the model) still waits on the
   * load, webgllm cancels it and the model is left unloaded.
   */
  createSessionWithProgress(
    options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
  ): Promise<this> {
    const { onDownloadProgress } = options
    const own = this.onDownloadProgress
    const ready = loadModel(this.model, {
      contextLength: this.contextLength,
      ...(options.signal && { signal: options.signal }),
      onDownloadProgress:
        own && onDownloadProgress
          ? (progress) => {
              own(progress)
              onDownloadProgress(progress)
            }
          : (own ?? onDownloadProgress)
    }).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /**
   * Unloads the model, freeing its GPU memory; a running generation of it
   * fails. The model is shared, so this unloads it for every adapter of it.
   * Its files stay downloaded. Never rejects.
   */
  destroySession(): Promise<void> {
    return unloadModel(this.model)
  }

  /** The request body shared by chats and structured output (tools and schema aside). */
  private body(options: TextOptions<WebGllmTextModelOptions>): ChatCompletionCreateParamsStreaming {
    return {
      model: this.model,
      messages: toMessages(options.systemPrompts, options.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...reasoningFields(options.reasoning, this.model),
      ...samplingFields(options.modelOptions),
      ...(options.promptCache?.retention === "none" && { cache_prompt: false })
    }
  }

  async *chatStream(options: TextOptions<WebGllmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const offered = options.toolChoice === "none" ? [] : toTools(options.tools)
    const repair = options.modelOptions?.repairToolCalls
    const parallel = options.modelOptions?.parallelToolCalls
    const body: ChatCompletionCreateParamsStreaming = {
      ...this.body(options),
      ...(offered.length && { tools: offered }),
      ...(offered.length && options.toolChoice && { tool_choice: toToolChoice(options.toolChoice) }),
      ...(repair !== undefined && { repair_tool_calls: repair }),
      ...(parallel !== undefined && { parallel_tool_calls: parallel })
    }
    const runId = options.runId ?? nextId("run")
    const threadId = options.threadId
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal = signalOf(options)
    if (signal?.aborted) return
    const model = this.model
    const timestamp = () => Date.now()

    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }

    try {
      await ensureModel(model, this.contextLength, signal, this.onDownloadProgress)
    } catch (error) {
      if (isAbort(error, signal)) return
      yield runError(model, error, true)
      return
    }

    let reasoning: "none" | "open" | "closed" = "none"
    let textStarted = false
    let text = ""
    let finishReason: FinishReason | undefined
    let usage: TokenUsage | undefined
    /** Tool calls by index, as they stream (webgllm sends each whole, after the text). */
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()

    function* endReasoning(): Generator<AdapterYieldChunk> {
      if (reasoning !== "open") return
      reasoning = "closed"
      yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
      yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
    }
    function* endText(): Generator<AdapterYieldChunk> {
      if (!textStarted) return
      textStarted = false
      yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
    }
    function* endToolCalls(): Generator<AdapterYieldChunk> {
      for (const call of toolCalls.values()) {
        let input: unknown
        try {
          input = JSON.parse(call.args || "{}")
        } catch {
          input = {}
        }
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: call.id,
          toolCallName: call.name,
          args: call.args,
          input,
          model,
          timestamp: timestamp()
        }
      }
      toolCalls.clear()
    }

    try {
      touchModel(model)
      const stream = await webgllm.chat.completions.create(body, { ...(signal && { signal }) })
      for await (const chunk of stream) {
        if (chunk.usage) usage = usageOf(chunk.usage, chunk.timings)
        const choice = chunk.choices[0]
        if (!choice) continue
        const { delta } = choice
        if (delta.reasoning_content) {
          if (reasoning === "none") {
            yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
            yield {
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningId,
              role: "reasoning",
              model,
              timestamp: timestamp()
            }
          }
          reasoning = "open"
          yield {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoningId,
            delta: delta.reasoning_content,
            model,
            timestamp: timestamp()
          }
        }
        if (delta.content) {
          yield* endReasoning()
          if (!textStarted) {
            textStarted = true
            yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
          }
          text += delta.content
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: delta.content,
            content: text,
            model,
            timestamp: timestamp()
          }
        }
        for (const part of delta.tool_calls ?? []) {
          yield* endReasoning()
          let call = toolCalls.get(part.index)
          if (!call) {
            call = { id: part.id ?? nextId("tool"), name: part.function.name ?? "", args: "" }
            toolCalls.set(part.index, call)
            yield {
              type: EventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: call.name,
              parentMessageId: messageId,
              index: part.index,
              model,
              timestamp: timestamp()
            }
          }
          const args = part.function.arguments
          if (args) {
            call.args += args
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: call.id,
              delta: args,
              args: call.args,
              model,
              timestamp: timestamp()
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    } catch (error) {
      yield* endReasoning()
      yield* endText()
      if (isAbort(error, signal)) return
      yield runError(model, error, false)
      return
    } finally {
      // (Its own budget may have unloaded another model, or this one crashed.)
    }

    yield* endReasoning()
    yield* endToolCalls()
    yield* endText()
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason: finishReason ?? "stop",
      ...(usage && { usage })
    }
  }

  /**
   * `chat({ outputSchema, stream: true })` (and, through `structuredOutput`,
   * `stream: false`): one streamed request that asks the model for JSON
   * matching the schema, which webgllm constrains its answer to. Emits
   * RUN_STARTED, the thinking as REASONING_* events, the raw JSON as
   * TEXT_MESSAGE_* deltas, a CUSTOM `structured-output.complete` with
   * `{ object, raw, reasoning? }`, then RUN_FINISHED with usage (`chat()`
   * validates the object). Failures are a RUN_ERROR, as in `chatStream`;
   * an abort ends the stream without one.
   */
  async *structuredOutputStream(
    options: StructuredOutputOptions<WebGllmTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    yield* this.structuredEvents(options, () => undefined)
  }

  /**
   * The structured stream's events; `fail` receives the error behind a
   * RUN_ERROR (or an abort), so `structuredOutput` can reject with it as is.
   */
  private async *structuredEvents(
    options: StructuredOutputOptions<WebGllmTextModelOptions>,
    fail: (error: unknown) => void
  ): AsyncGenerator<AdapterYieldChunk> {
    const { chatOptions, outputSchema } = options
    // Small models constrained to a schema they weren't asked for write poor values: ask too.
    const instruction = `Answer with only a JSON value matching this JSON Schema:\n${JSON.stringify(outputSchema)}`
    const body: ChatCompletionCreateParamsStreaming = {
      ...this.body({
        ...chatOptions,
        systemPrompts: [...normalizeSystemPrompts(chatOptions.systemPrompts), { content: instruction }]
      }),
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", schema: outputSchema as Record<string, unknown> }
      }
    }
    const runId = chatOptions.runId ?? nextId("run")
    const threadId = chatOptions.threadId
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal = signalOf(chatOptions)
    if (signal?.aborted) return
    const model = this.model
    const timestamp = () => Date.now()

    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(chatOptions.parentRunId && { parentRunId: chatOptions.parentRunId })
    }

    try {
      await ensureModel(model, this.contextLength, signal, this.onDownloadProgress)
    } catch (error) {
      fail(error)
      if (isAbort(error, signal)) return
      yield runError(model, error, true)
      return
    }

    let reasoningState: "none" | "open" | "closed" = "none"
    let reasoning = ""
    let textStarted = false
    let raw = ""
    let finishReason: FinishReason | undefined
    let usage: TokenUsage | undefined

    function* endReasoning(): Generator<AdapterYieldChunk> {
      if (reasoningState !== "open") return
      reasoningState = "closed"
      yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
      yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
    }
    function* endText(): Generator<AdapterYieldChunk> {
      if (!textStarted) return
      textStarted = false
      yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
    }

    try {
      touchModel(model)
      const stream = await webgllm.chat.completions.create(body, { ...(signal && { signal }) })
      for await (const chunk of stream) {
        // Stop reading (which stops webgllm's generation) once aborted.
        if (signal?.aborted) break
        if (chunk.usage) usage = usageOf(chunk.usage, chunk.timings)
        const choice = chunk.choices[0]
        if (!choice) continue
        const { delta } = choice
        if (delta.reasoning_content) {
          if (reasoningState === "none") {
            yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
            yield {
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningId,
              role: "reasoning",
              model,
              timestamp: timestamp()
            }
          }
          reasoningState = "open"
          reasoning += delta.reasoning_content
          yield {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoningId,
            delta: delta.reasoning_content,
            model,
            timestamp: timestamp()
          }
        }
        if (delta.content) {
          yield* endReasoning()
          if (!textStarted) {
            textStarted = true
            yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
          }
          raw += delta.content
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: delta.content,
            content: raw,
            model,
            timestamp: timestamp()
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    } catch (error) {
      fail(error)
      yield* endReasoning()
      yield* endText()
      if (isAbort(error, signal)) return
      yield runError(model, error, false)
      return
    } finally {
      // (Its own budget may have unloaded another model, or this one crashed.)
    }

    yield* endReasoning()
    yield* endText()
    if (signal?.aborted) return

    let object: unknown
    try {
      object = JSON.parse(raw) as unknown
    } catch (cause) {
      const cut = finishReason === "length"
      const message = cut
        ? "The answer was cut off at the output token limit (finish_reason=length); raise maxCompletionTokens."
        : `The model's answer isn't JSON: ${raw.slice(0, 200)}${raw.length > 200 ? "…" : ""}`
      const code = cut ? "max_tokens" : "structured-output-parse-failed"
      fail(new Error(message, { cause }))
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: timestamp(),
        message,
        code,
        errorType: code,
        error: { message, code },
        ...(usage && { usage })
      } as AdapterYieldChunk
      return
    }
    yield {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: { object, raw, ...(reasoning && { reasoning }) },
      model,
      timestamp: timestamp()
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason: finishReason ?? "stop",
      ...(usage && { usage })
    }
  }

  /**
   * `structuredOutputStream` drained to its result: rejects with webgllm's
   * error as it is, the abort signal's reason, or an error for an answer
   * that isn't JSON.
   */
  async structuredOutput(
    options: StructuredOutputOptions<WebGllmTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const signal = signalOf(options.chatOptions)
    signal?.throwIfAborted()
    let failure: { error: unknown } | undefined
    let result: StructuredOutputResult<unknown> | undefined
    let usage: TokenUsage | undefined
    for await (const event of this.structuredEvents(options, (error) => (failure = { error }))) {
      if (event.type === EventType.CUSTOM && event.name === "structured-output.complete") {
        const value = event.value as { object: unknown; raw: string }
        result = { data: value.object, rawText: value.raw }
      } else if (event.type === EventType.RUN_FINISHED && event.usage && !Array.isArray(event.usage)) {
        usage = event.usage
      }
    }
    signal?.throwIfAborted()
    if (failure) throw failure.error
    if (!result) throw new Error("The structured output stream ended without a result.")
    return { ...result, ...(usage && { usage }) }
  }
}

/**
 * A TanStack AI text adapter for a webgllm model on WebGL 2, for browsers
 * without WebGPU (Firefox on Android, for one).
 *
 * @example
 * ```ts
 * chat({ adapter: webgllmText("LiquidAI/LFM3-1.7B-GGUF"), messages, threadId })
 * ```
 */
export function webgllmText<TModel extends WebGllmChatModel>(
  model: TModel,
  config?: WebGllmConfig
): WebGllmTextAdapter<TModel> {
  return new WebGllmTextAdapter(config ?? {}, model)
}
