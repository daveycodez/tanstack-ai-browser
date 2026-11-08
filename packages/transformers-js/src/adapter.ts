import { chooseGuidedTool, addGuidedUsage, closeObjects, validateStructuredValue } from "./constraint/index.js"
/**
 * A TanStack AI text adapter for Transformers.js models that run in the
 * browser, on WebGPU in a Web Worker. Hand it to `chat()` like any hosted
 * model's adapter: `chat()` runs tools and the agent loop, and each
 * `chatStream` call here is one generation in the worker, streamed back as
 * AG-UI events.
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
import type {
  StructuredOutputOptions,
  StructuredOutputResult
} from "@tanstack/ai/adapters"

import {
  availability,
  generate,
  loadModel,
  setDebug,
  setKeepLoaded,
  unloadModel
} from "./client.js"
import type { Availability, DownloadProgressCallback } from "./client.js"
import { modelMeta, modelReasoning } from "./catalog.js"
import type {
  Sampling,
  TransformersJsListedId,
  TransformersJsModelReasoningByName
} from "./catalog.js"
import type {
  ChatTurn,
  RunTimings,
  ToolSpec,
  WeightsDtype,
  WorkerSampling
} from "./protocol.js"
import {
  createStructuredSplitter,
  createThinkingSplitter,
  THINKING_MARKERS
} from "./thinking.js"
import {
  createToolCallSplitter,
  formatLfm2ToolCalls,
  parseToolCalls
} from "./tool-calls.js"
import type { ParsedToolCall, ToolFormat } from "./tool-calls.js"

export type TransformersJsConfig = {
  /**
   * How the model writes tool calls: LFM2's markers or LFM3's XML-ish calls.
   * A listed model's own by default; required for any other model.
   */
  toolFormat?: ToolFormat
  /**
   * Tokens a chat may hold, prompt and reply together: the model's whole
   * context window by default (from its config), never more. Less keeps
   * the model's cache, which grows with the chat, smaller.
   */
  contextLength?: number
  /**
   * The weights to load: a listed model's own by default, else "q4f16".
   * "q4" (fp32 activations) is for models that overflow fp16.
   */
  dtype?: WeightsDtype
  /** Memory and cache logs from the worker, in the console. */
  debug?: boolean
  /**
   * Keeps the model loaded when another runtime (WebGL, wllama) loads one
   * past the page's memory budget (see `setMemoryBudget`); by default the
   * least recently used model is unloaded to make room.
   */
  keepLoaded?: boolean
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `createSessionWithProgress`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/** The config a model takes: any other model than a listed one names its tool format. */
export type TransformersJsConfigFor<TModel extends string> =
  TModel extends TransformersJsListedId
    ? TransformersJsConfig
    : TransformersJsConfig & { toolFormat: ToolFormat }

/**
 * Per-call `modelOptions`, named as OpenRouter's adapter names them, so an
 * app can swap this adapter for `@tanstack/ai-openrouter`'s unchanged.
 * Sampling left out comes from the model card (a listed model) or the
 * defaults (any other).
 */
export type TransformersJsTextModelOptions = {
  /** Most tokens to generate, thinking included; otherwise the remaining model context. */
  maxCompletionTokens?: number
  /** Randomness of sampling: 0 is greedy. */
  temperature?: number
  /** Nucleus sampling: the likeliest tokens up to this probability, in (0, 1]. */
  topP?: number
  /** Seeds the sampler, for the same samples from the same request. */
  seed?: number
  /**
   * Not supported by this engine: 0 (or leaving it out) only; anything
   * else throws. Use `repetitionPenalty`.
   */
  frequencyPenalty?: number
  /** Not supported by this engine: 0 (or leaving it out) only; anything else throws. */
  presencePenalty?: number
  /** Not supported by this engine: leaving it out (or none) only; anything else throws. */
  stop?: string | Array<string>
  /** Sampling from the likeliest `topK` tokens only (0: all of them). */
  topK?: number
  /** Divides the scores of tokens already in the chat (1: off). */
  repetitionPenalty?: number
  /**
   * False keeps only the first tool call of a reply (the model still writes
   * the rest; they're dropped). True or left out: every call it writes.
   */
  parallelToolCalls?: boolean
}

/**
 * Timings of one model call, in milliseconds, in `RUN_FINISHED`'s
 * `usage.providerUsageDetails`.
 */
export type TransformersJsProviderUsageDetails = {
  /** From the request to the first generated token, reading the prompt included. */
  firstTokenMs?: number
  /** From starting to read the prompt (the model loaded) to the first token. */
  promptMs?: number
  /** From the first generated token to the last. */
  decodeMs?: number
  /** Tokens generated after the first one, over `decodeMs`. */
  decodeTokens?: number
  thinkingTokens?: number
  thinkingBudgetTokens?: number
  thinkingBudgetExhausted?: boolean
}

/**
 * The reasoning levels of a model, for `chat({ reasoning })`. A model this
 * package doesn't list gets the on/off toggle (the chat template's
 * `enable_thinking`). `never`: a listed model that doesn't reason. A listed
 * model pinned to a revision ("@commit") reasons as the model does.
 */
type ResolveReasoning<TModel extends string> =
  TModel extends keyof TransformersJsModelReasoningByName
    ? TransformersJsModelReasoningByName[TModel]
    : TModel extends `${infer Name extends keyof TransformersJsModelReasoningByName}@${string}`
      ? TransformersJsModelReasoningByName[Name]
      : TModel extends TransformersJsListedId
        ? never
        : { levels: "off" | "high"; budget: true }

/** Sampling for a model this package doesn't list. */
const DEFAULT_SAMPLING: Sampling = {
  temperature: 0.7,
  topK: 50,
  repetitionPenalty: 1
}

/**
 * The chat template's `enable_thinking` for a request: true or false for a
 * model that reasons, left out when the request doesn't ask (the template's
 * default applies), false for a model that doesn't reason.
 */
function thinkingOptions(request: ReasoningRequest | undefined, model: string) {
  const budget = request?.budgetTokens
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0))
    throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  const reasoning = modelReasoning(model)
  if (!reasoning) return { thinking: false }
  const value = resolveReasoning(request, reasoning)?.value
  const mandatory = "levels" in reasoning && !Object.prototype.hasOwnProperty.call(reasoning.levels, "off")
  const thinking = value === undefined ? (mandatory ? true : undefined) : value === "true"
  return { thinking, ...(budget !== undefined && thinking !== false && { thinkingBudgetTokens: budget }) }
}

/**
 * A call's sampling and output cap: `modelOptions` over the model card's
 * sampling, in the worker's names. Options this engine can't honour throw.
 */
function generationSettings(
  options: TransformersJsTextModelOptions | undefined,
  base: Sampling
): { sampling: WorkerSampling; maxTokens: number | undefined } {
  const {
    maxCompletionTokens,
    temperature = base.temperature,
    topP = base.topP,
    topK = base.topK,
    repetitionPenalty = base.repetitionPenalty,
    seed,
    frequencyPenalty,
    presencePenalty,
    stop,
    parallelToolCalls
  } = options ?? {}
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean")
    throw new TypeError("parallelToolCalls must be a boolean.")
  if (maxCompletionTokens !== undefined && (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 0))
    throw new RangeError("maxCompletionTokens must be a nonnegative safe integer.")
  if (!Number.isFinite(temperature) || temperature < 0)
    throw new RangeError("temperature must be a nonnegative number.")
  if (topP !== undefined && (!Number.isFinite(topP) || topP <= 0 || topP > 1))
    throw new RangeError("topP must be a number in (0, 1].")
  if (!Number.isSafeInteger(topK) || topK < 0)
    throw new RangeError("topK must be a nonnegative safe integer.")
  if (!Number.isFinite(repetitionPenalty) || repetitionPenalty <= 0)
    throw new RangeError("repetitionPenalty must be a positive number.")
  if (seed !== undefined && !Number.isSafeInteger(seed))
    throw new RangeError("seed must be a safe integer.")
  if (frequencyPenalty !== undefined && frequencyPenalty !== 0)
    throw new Error("transformers-js doesn't support frequencyPenalty; use repetitionPenalty.")
  if (presencePenalty !== undefined && presencePenalty !== 0)
    throw new Error("transformers-js doesn't support presencePenalty; use repetitionPenalty.")
  if (stop !== undefined && (typeof stop === "string" || stop.length > 0))
    throw new Error("transformers-js doesn't support stop sequences.")
  return {
    sampling: {
      temperature,
      top_k: topK,
      repetition_penalty: repetitionPenalty,
      ...(topP !== undefined && { top_p: topP }),
      ...(seed !== undefined && { seed })
    },
    maxTokens: maxCompletionTokens
  }
}

/** Cancel the caller's wait without discarding an in-progress model download. */
function waitForModel(model: string, dtype: WeightsDtype, contextLength: number | undefined, signal: AbortSignal | undefined, onDownloadProgress?: DownloadProgressCallback): Promise<void> {
  signal?.throwIfAborted()
  return loadModel(model, { dtype, contextLength, onDownloadProgress, signal, chatWait: true })
}

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

/** A tool call's text content, or the error a failed tool gave. */
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

/** A tool call's JSON arguments, or {} if they aren't JSON. */
function parseArguments(json: string): Record<string, unknown> {
  try {
    const args = JSON.parse(json) as unknown
    return args && typeof args === "object"
      ? (args as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** An assistant turn with tool calls, written the way the model writes them. */
function assistantToolTurn(
  content: string,
  calls: Array<ParsedToolCall & { id: string }>,
  format: ToolFormat
): ChatTurn {
  if (format === "lfm2") {
    return { role: "assistant", content: content + formatLfm2ToolCalls(calls) }
  }
  return {
    role: "assistant",
    content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args }
    }))
  }
}

/** The current turn's thinking, under the key the format's template reads. */
function withThinking(turn: ChatTurn, thinking: string, format: ToolFormat) {
  // Liquid's guide: keep the reasoning of the current tool-use turn.
  if (format === "lfm3") return { ...turn, thinking }
  if (format === "qwen3.5") return { ...turn, reasoning_content: thinking }
  if (format === "gemma4") return { ...turn, reasoning: thinking }
  return turn
}

/**
 * The conversation as chat-template turns. Tool calls and results from
 * earlier turns are left out and their answers kept: small models copy the
 * shape of past calls badly and get lost in old results. The current turn's
 * calls and results stay, since the model answers from them.
 */
function toChatTurns(messages: Array<ModelMessage>, format: ToolFormat) {
  const chat: Array<ChatTurn> = []
  const currentTurn = messages.map((m) => m.role).lastIndexOf("user")
  // Tool names by call id, for the results.
  const toolNames = new Map<string, string>()
  for (const [i, m] of messages.entries()) {
    const content = contentText(m.content)
    const earlier = i < currentTurn
    if (m.role === "tool") {
      if (earlier) continue
      const name = m.toolCallId ? toolNames.get(m.toolCallId) : undefined
      chat.push({
        role: "tool",
        content: toolResultText(m),
        ...(m.toolCallId && { tool_call_id: m.toolCallId }),
        ...(name && { name })
      })
      continue
    }
    const calls = (m.toolCalls ?? []).map((call) => {
      toolNames.set(call.id, call.function.name)
      return {
        id: call.id,
        name: call.function.name,
        args: parseArguments(call.function.arguments)
      }
    })
    if (m.role === "user" || calls.length === 0 || earlier) {
      if (content) chat.push({ role: m.role, content })
      continue
    }
    const turn = assistantToolTurn(content, calls, format)
    const thinking = m.thinking?.map((t) => t.content).join("")
    chat.push(thinking ? withThinking(turn, thinking, format) : turn)
  }
  return chat
}

/** Tools as chat templates take them (OpenAI's function format). */
function toToolSpecs(tools: Array<Tool> | undefined): Array<ToolSpec> {
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

/** A model call's counts as TanStack AI usage, its timings as provider details. */
function usageOf(stats: RunTimings): TokenUsage {
  const usage = buildBaseUsage<TransformersJsProviderUsageDetails>({
    promptTokens: stats.inputTokens,
    completionTokens: stats.outputTokens,
    totalTokens: stats.inputTokens + stats.outputTokens
  })
  if (stats.cachedTokens > 0) {
    usage.promptTokensDetails = { cachedTokens: stats.cachedTokens }
  }
  usage.providerUsageDetails = {
    ...(stats.firstTokenMs !== null && { firstTokenMs: stats.firstTokenMs }),
    ...(stats.promptMs !== null && { promptMs: stats.promptMs }),
    ...(stats.thinkingTokens !== undefined && { thinkingTokens: stats.thinkingTokens }),
    ...(stats.thinkingBudgetTokens !== undefined && { thinkingBudgetTokens: stats.thinkingBudgetTokens }),
    ...(stats.thinkingBudgetExhausted !== undefined && { thinkingBudgetExhausted: stats.thinkingBudgetExhausted }),
    ...(stats.firstTokenMs !== null && {
      decodeMs: stats.decodeMs,
      decodeTokens: Math.max(stats.outputTokens - 1, 0)
    })
  }
  return usage
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** The call's cancellation: the legacy controller's, else the request's. */
const signalOf = (options: TextOptions<TransformersJsTextModelOptions>) =>
  options.abortController?.signal ??
  (options.request as RequestInit | undefined)?.signal ??
  undefined

const STRUCTURED_OUTPUT_COMPLETE = "structured-output.complete"

/** The `structured-output.complete` event's value. */
type StructuredOutputComplete = { object: unknown; raw: string; reasoning?: string }

/** Both progress callbacks, as one (or the one given). */
function combine(
  a: DownloadProgressCallback | undefined,
  b: DownloadProgressCallback | undefined
): DownloadProgressCallback | undefined {
  if (!a || !b) return a ?? b
  return (progress) => {
    a(progress)
    b(progress)
  }
}

let calls = 0
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(calls++).toString(36)}`

export class TransformersJsTextAdapter<
  TModel extends string
> extends BaseTextAdapter<
  TModel,
  TransformersJsTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ResolveReasoning<TModel>
> {
  override readonly kind = "text" as const
  readonly name = "transformers-js" as const
  override readonly api = "transformers-js" as const
  override readonly inputModalities = ["text"] as const
  private readonly toolFormat: ToolFormat
  private readonly contextLength: number | undefined
  private readonly dtype: WeightsDtype
  private readonly onDownloadProgress: DownloadProgressCallback | undefined

  constructor(config: TransformersJsConfig, model: TModel) {
    super({}, model)
    const toolFormat = config.toolFormat ?? modelMeta(model)?.toolFormat
    if (!toolFormat) {
      throw new Error(
        `Set toolFormat for ${model}: it isn't a model this package lists.`
      )
    }
    this.toolFormat = toolFormat
    // Left out, the worker uses the model's own context window.
    this.contextLength = config.contextLength
    this.dtype = config.dtype ?? modelMeta(model)?.dtype ?? "q4f16"
    this.onDownloadProgress = config.onDownloadProgress
    if (config.debug) setDebug(true)
    setKeepLoaded(model, config.keepLoaded ?? false)
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where it can't run (no Web Worker or WebAssembly, as on a
   * server, or no WebGPU and no CPU weights), "available" when it's loaded
   * and ready in this page (by any adapter of it, for this `dtype`), else
   * "downloadable", even while it loads or when its files are cached (a
   * load then reads them). It never says "downloading": progress comes from
   * `createSessionWithProgress`. It reads no storage and starts no worker.
   */
  availability(): Promise<Availability> {
    return availability(this.model, { dtype: this.dtype })
  }

  /**
   * Loads the model (downloading it the first time), with the download's
   * progress, 0 to 1, then 1 once it's ready. Resolves to this adapter when
   * it's ready; rejects if it can't load (fine to leave unawaited). `chat()` doesn't need it (its
   * first call loads the model), but it lets a page load ahead of time.
   * Adapters for the same model (and `dtype` and `contextLength`) share one
   * loaded model; the page holds one Transformers.js model at a time.
   * Aborting `signal` rejects this call at once with an AbortError and
   * stops its progress reports; if no other caller (another call, or a
   * chat waiting for the model) still waits on the load, it's cancelled:
   * the worker ends and the model is left unloaded.
   */
  createSessionWithProgress(
    options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
  ): Promise<this> {
    const { onDownloadProgress } = options
    const ready = loadModel(this.model, {
      dtype: this.dtype,
      contextLength: this.contextLength,
      onDownloadProgress: combine(this.onDownloadProgress, onDownloadProgress),
      ...(options.signal && { signal: options.signal })
    }).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /**
   * Unloads the model, freeing its GPU and WebAssembly memory, if it's the
   * one loaded (or loading); a running generation of it fails. The model
   * is shared, so this unloads it for every adapter of it. Its files stay
   * downloaded.
   */
  async destroySession(): Promise<void> {
    await unloadModel(this.model)
  }

  /** Sampling and output cap for a call: `modelOptions` over the model card's or the defaults. */
  private settings(
    modelOptions: TransformersJsTextModelOptions | undefined
  ) {
    return generationSettings(
      modelOptions,
      modelMeta(this.model)?.sampling ?? DEFAULT_SAMPLING
    )
  }

  async *chatStream(
    options: TextOptions<TransformersJsTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const threadId = options.threadId
    const callId = nextId("call")
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal = signalOf(options)
    const model = this.model
    const { sampling, maxTokens } = this.settings(options.modelOptions)
    const thinking = thinkingOptions(options.reasoning, model)
    const timestamp = () => Date.now()

    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }
    if (options.tools?.length && (options.toolChoice === "required" || typeof options.toolChoice === "object")) {
      try {
        const { call, usage } = await chooseGuidedTool(options, (outputSchema, instruction) =>
          this.structuredOutput({
            chatOptions: { ...options, systemPrompts: [...normalizeSystemPrompts(options.systemPrompts), { content: instruction }] },
            outputSchema
          })
        )
        if (signal?.aborted) return
        if (call) {
          const toolCallId = nextId("tool")
          const args = JSON.stringify(call.args)
          yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: call.name, parentMessageId: messageId, index: 0, model, timestamp: timestamp() }
          yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args, args, model, timestamp: timestamp() }
          yield { type: EventType.TOOL_CALL_END, toolCallId, toolCallName: call.name, args, input: call.args, model, timestamp: timestamp() }
          yield { type: EventType.RUN_FINISHED, runId, threadId, model, timestamp: timestamp(), finishReason: "tool_calls", ...(usage && { usage }) }
        } else {
          for await (const chunk of this.chatStream({ ...options, runId, tools: [], toolChoice: "none" })) {
            if (chunk.type === EventType.RUN_STARTED) continue
            if (chunk.type === EventType.RUN_FINISHED) {
              const reported = Array.isArray(chunk.usage) ? chunk.usage[0] : chunk.usage
              yield { ...chunk, usage: addGuidedUsage(usage, reported) }
            } else yield chunk
          }
        }
      } catch (error) {
        if (signal?.aborted) return
        const message = errorText(error)
        yield { type: EventType.RUN_ERROR, model, timestamp: timestamp(), message, error: { message } }
      }
      return
    }
    try {
      await waitForModel(model, this.dtype, this.contextLength, signal, this.onDownloadProgress)
    } catch (error) {
      if (signal?.aborted) return
      yield {
        type: EventType.RUN_ERROR,
        model,
        timestamp: timestamp(),
        message: `Couldn't load ${model}: ${errorText(error)}`,
        error: { message: `Couldn't load ${model}: ${errorText(error)}` }
      }
      return
    }

    const system = normalizeSystemPrompts(options.systemPrompts)
      .map((p) => p.content)
      .join("\n\n")
    const chat: Array<ChatTurn> = [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...toChatTurns(options.messages, this.toolFormat)
    ]
    const tools = options.toolChoice === "none" ? [] : toToolSpecs(options.tools)

    // Thinking streams as reasoning events, then the answer as text up to
    // any tool-call markup, which is held back and parsed at the end.
    let reasoning: "none" | "open" | "closed" = "none"
    let textStarted = false
    let text = ""
    const thinkingSplitter = createThinkingSplitter(
      THINKING_MARKERS[this.toolFormat]
    )
    const toolSplitter = createToolCallSplitter()
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
    const addText = (delta: string) => {
      if (!delta) return
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
    const addPieces = (pieces: ReturnType<typeof thinkingSplitter.push>) => {
      for (const piece of pieces) {
        if (piece.kind === "thinking") {
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
            delta: piece.text,
            model,
            timestamp: timestamp()
          })
        } else {
          endReasoning()
          addText(toolSplitter.push(piece.text))
        }
      }
    }

    const stream = generate({
      id: callId,
      chat,
      tools,
      ...(options.promptCache?.retention === "none" && { cachePrompt: false }),
      ...thinking,
      sampling,
      maxTokens,
      contextLength: this.contextLength,
      thinkingOpen: THINKING_MARKERS[this.toolFormat].open,
      thinkingClose: THINKING_MARKERS[this.toolFormat].close,
      signal
    })
    let next = await stream.next()
    try {
      while (!next.done) {
        addPieces(thinkingSplitter.push(next.value))
        yield* events.splice(0)
        next = await stream.next()
      }
    } finally {
      if (!next.done) await stream.return({})
    }
    const { failure, stats } = next.value
    addPieces(thinkingSplitter.flush())
    endReasoning()
    const { text: rest, markup } = toolSplitter.flush()
    addText(rest)
    const allParsed = markup && options.tools?.length && options.toolChoice !== "none" ? parseToolCalls(markup) : []
    // parallelToolCalls: false keeps the first call only (before validating or repairing the rest).
    const parsed = options.modelOptions?.parallelToolCalls === false ? allParsed.slice(0, 1) : allParsed
    const nativeTools = !!options.tools?.length && options.toolChoice !== "none"
    if (markup && parsed.length === 0 && !nativeTools) addText(markup)
    yield* events.splice(0)
    let usage = stats ? usageOf(stats) : undefined
    try {
      if (failure) throw new Error(failure)
      if (markup && nativeTools && parsed.length === 0) throw new Error("The model returned malformed tool-call markup.")
      for (const call of parsed) {
        signal?.throwIfAborted()
        const tool = options.tools?.find(tool => tool.name === call.name)
        if (!tool) throw new Error(`The model requested an undeclared tool: ${call.name}`)
        const schema = tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false }
        if (!await validateStructuredValue(schema, call.args)) {
          const repair = await this.structuredOutput({
            chatOptions: { ...options, systemPrompts: [...normalizeSystemPrompts(options.systemPrompts), { content: `Return the correct arguments for the selected tool ${call.name}. ${tool.description}. Draft arguments to correct: ${JSON.stringify(call.args)}` }] },
            outputSchema: schema as Record<string, unknown>
          })
          signal?.throwIfAborted()
          if (!repair.data || typeof repair.data !== "object" || Array.isArray(repair.data) || !await validateStructuredValue(schema, repair.data)) throw new Error(`Invalid arguments for tool: ${call.name}`)
          call.args = repair.data as Record<string, unknown>
          usage = addGuidedUsage(usage, repair.usage)
        }
      }
    } catch (error) {
      if (textStarted) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      if (signal?.aborted) return
      const message = errorText(error)
      yield { type: EventType.RUN_ERROR, model, timestamp: timestamp(), message, error: { message } }
      return
    }

    for (const [index, call] of parsed.entries()) {
      const toolCallId = nextId("tool")
      const args = JSON.stringify(call.args)
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: call.name,
        parentMessageId: messageId,
        index,
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
        toolCallName: call.name,
        args,
        input: call.args,
        model,
        timestamp: timestamp()
      }
    }
    if (textStarted) {
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: timestamp()
      }
    }
    if (failure) {
      yield {
        type: EventType.RUN_ERROR,
        model,
        timestamp: timestamp(),
        message: failure,
        error: { message: failure }
      }
      return
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason: parsed.length > 0 ? "tool_calls" : "stop",
      ...(usage && { usage })
    }
  }

  /**
   * A schema-constrained JSON answer through the public logits-processor
   * hook: `structuredOutputStream` drained. `chat()` additionally validates
   * the completed result.
   */
  async structuredOutput(
    options: StructuredOutputOptions<TransformersJsTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    let complete: StructuredOutputComplete | undefined
    let usage: TokenUsage | undefined
    for await (const chunk of this.structuredEvents(options)) {
      if (chunk.type === EventType.CUSTOM && chunk.name === STRUCTURED_OUTPUT_COMPLETE)
        complete = chunk.value as StructuredOutputComplete
      if (chunk.type === EventType.RUN_FINISHED && chunk.usage && !Array.isArray(chunk.usage))
        usage = chunk.usage as TokenUsage
    }
    if (!complete) throw new Error("The model's structured answer didn't complete.")
    return {
      data: complete.object,
      rawText: complete.raw,
      ...(usage && { usage })
    }
  }

  /**
   * `chat({ outputSchema, stream: true })`: the model's thinking as
   * `REASONING_*` events, the schema-constrained JSON as `TEXT_MESSAGE_*`
   * deltas, then a `CUSTOM` `structured-output.complete` event with
   * `{ object, raw, reasoning? }` and `RUN_FINISHED` with usage. A failure
   * ends the run with `RUN_ERROR` instead.
   */
  async *structuredOutputStream(
    options: StructuredOutputOptions<TransformersJsTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const { chatOptions } = options
    const runId = chatOptions.runId ?? nextId("run")
    let started = false
    try {
      for await (const chunk of this.structuredEvents(options, runId)) {
        if (chunk.type === EventType.RUN_STARTED) started = true
        yield chunk
      }
    } catch (error) {
      const model = this.model
      if (!started) {
        yield {
          type: EventType.RUN_STARTED,
          runId,
          threadId: chatOptions.threadId,
          model,
          timestamp: Date.now(),
          ...(chatOptions.parentRunId && { parentRunId: chatOptions.parentRunId })
        }
      }
      const aborted = signalOf(chatOptions)?.aborted === true
      const message = aborted ? "The structured output was canceled." : errorText(error)
      const code = aborted ? "aborted" : error instanceof SyntaxError ? "structured-output-parse-failed" : undefined
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: Date.now(),
        message,
        ...(code && { code }),
        error: { message, ...(code && { code }) }
      }
    }
  }

  /**
   * The structured-output run's events; failures (cancellation included,
   * with the signal's own reason) are thrown, for `structuredOutput` to
   * reject with and `structuredOutputStream` to report as `RUN_ERROR`.
   */
  private async *structuredEvents(
    options: StructuredOutputOptions<TransformersJsTextModelOptions>,
    runId = options.chatOptions.runId ?? nextId("run")
  ): AsyncGenerator<AdapterYieldChunk> {
    const { chatOptions } = options
    // Closed unless they say otherwise, as in OpenAI's strict mode, for the
    // answer and for tool arguments alike: a free-form key costs the
    // constraint about a second a token on a real vocabulary
    // (https://github.com/nico-martin/llguidance-js/issues/5).
    const outputSchema = closeObjects(options.outputSchema) as Record<string, unknown>
    const model = this.model
    const threadId = chatOptions.threadId
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal = signalOf(chatOptions)
    const timestamp = () => Date.now()
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(chatOptions.parentRunId && { parentRunId: chatOptions.parentRunId })
    }
    const thinking = thinkingOptions(chatOptions.reasoning, model)
    const { sampling, maxTokens } = this.settings(chatOptions.modelOptions)
    await waitForModel(model, this.dtype, this.contextLength, signal, this.onDownloadProgress)
    signal?.throwIfAborted()
    const system = normalizeSystemPrompts(chatOptions.systemPrompts)
      .map((p) => p.content)
      .concat(
        `Answer with only a JSON value matching this JSON Schema:\n${JSON.stringify(outputSchema)}`
      )
      .join("\n\n")
    const markers = THINKING_MARKERS[this.toolFormat]
    const stream = generate({
      id: nextId("call"),
      chat: [
        { role: "system", content: system },
        ...toChatTurns(chatOptions.messages, this.toolFormat)
      ],
      tools: [],
      ...(chatOptions.promptCache?.retention === "none" && { cachePrompt: false }),
      ...thinking,
      outputSchema,
      sampling,
      maxTokens,
      contextLength: this.contextLength,
      thinkingOpen: markers.open,
      thinkingClose: markers.close,
      signal
    })
    // Thinking, if the reply opens with it, then the JSON answer, where
    // marker-shaped text is data.
    const splitter = createStructuredSplitter(markers)
    let reasoning: "none" | "open" | "closed" = "none"
    let reasoningText = ""
    let textStarted = false
    let text = ""
    const events = (pieces: ReturnType<typeof splitter.push>) => {
      const out: Array<AdapterYieldChunk> = []
      for (const piece of pieces) {
        if (piece.kind === "thinking") {
          if (reasoning === "none") {
            reasoning = "open"
            out.push(
              { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() },
              { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
            )
          }
          reasoningText += piece.text
          out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: piece.text, model, timestamp: timestamp() })
          continue
        }
        out.push(...endReasoning())
        if (!textStarted) {
          textStarted = true
          out.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() })
        }
        text += piece.text
        out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: piece.text, content: text, model, timestamp: timestamp() })
      }
      return out
    }
    const endReasoning = (): Array<AdapterYieldChunk> => {
      if (reasoning !== "open") return []
      reasoning = "closed"
      return [
        { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() },
        { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
      ]
    }
    let next = await stream.next()
    try {
      while (!next.done) {
        signal?.throwIfAborted()
        yield* events(splitter.push(next.value))
        next = await stream.next()
      }
    } finally {
      if (!next.done) await stream.return({})
    }
    signal?.throwIfAborted()
    yield* events(splitter.flush())
    yield* endReasoning()
    if (textStarted) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
    if (next.value.failure) throw new Error(next.value.failure)
    const raw = text.trim()
    let object: unknown
    try {
      object = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) as unknown
    } catch (error) {
      throw new SyntaxError(
        `The model's answer isn't JSON: ${raw.slice(0, 200)}${raw.length > 200 ? "…" : ""}`,
        { cause: error }
      )
    }
    const value: StructuredOutputComplete = {
      object,
      raw,
      ...(reasoningText && { reasoning: reasoningText })
    }
    yield { type: EventType.CUSTOM, name: STRUCTURED_OUTPUT_COMPLETE, value, model, timestamp: timestamp() }
    const usage = next.value.stats ? usageOf(next.value.stats) : undefined
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason: "stop",
      ...(usage && { usage })
    }
  }
}

/**
 * A TanStack AI text adapter for a Transformers.js model in the browser: a
 * model this package lists (`TRANSFORMERS_JS_CHAT_MODELS`), which needs no
 * config, or any other Hugging Face ONNX model, given its tool format.
 *
 * @example
 * ```ts
 * chat({
 *   adapter: transformersJsText("daveycodez/LFM3-1.7B-Web-ONNX"),
 *   messages,
 *   threadId,
 *   reasoning: "high"
 * })
 * ```
 */
export function transformersJsText<TModel extends string>(
  model: TModel,
  ...[config]: TModel extends TransformersJsListedId
    ? [config?: TransformersJsConfigFor<TModel>]
    : [config: TransformersJsConfigFor<TModel>]
): TransformersJsTextAdapter<TModel> {
  return new TransformersJsTextAdapter(config ?? {}, model)
}
