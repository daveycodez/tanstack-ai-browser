import { chooseGuidedTool, addGuidedUsage, validateStructuredValue } from "@tanstack-ai-browser/structured-output"
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

import { generate, loadModel, setDebug, setKeepLoaded } from "./client.js"
import { modelMeta, modelReasoning } from "./model-meta.js"
import type {
  TransformersJsListedModel,
  TransformersJsModelReasoningByName
} from "./model-meta.js"
import type {
  ChatTurn,
  RunTimings,
  Sampling,
  ToolSpec,
  WeightsDtype
} from "./protocol.js"
import {
  createThinkingSplitter,
  structuredAnswer,
  THINKING_MARKERS
} from "./thinking.js"
import {
  createToolCallSplitter,
  formatLfm2ToolCalls,
  parseToolCalls
} from "./tool-calls.js"
import type { ParsedToolCall, ToolFormat } from "./tool-calls.js"

export type TransformersJsTextConfig = {
  /**
   * How the model writes tool calls: LFM2's markers or LFM3's XML-ish calls.
   * A listed model's own by default; required for any other model.
   */
  toolFormat?: ToolFormat
  /**
   * Tokens a chat may hold, prompt and reply together: the model's whole
   * context window by default (from its config). Less saves memory: the
   * model's rotary tables are cut to it when it loads. On an iPhone, LFM
   * models need 8,192 at most: past it, ONNX Runtime's buffer cache moves
   * their attention memory to buffers larger than iPhone Safari allows.
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
}

/** The config a model takes: any other model than a listed one names its tool format. */
export type TransformersJsTextConfigFor<TModel extends string> =
  TModel extends TransformersJsListedModel
    ? TransformersJsTextConfig
    : TransformersJsTextConfig & { toolFormat: ToolFormat }

/**
 * Per-call `modelOptions`: sampling, over the model card's (a listed
 * model's) or the defaults (any other), and the most tokens to generate.
 */
export type TransformersJsTextProviderOptions = Partial<Sampling> & {
  /** Maximum generated tokens, thinking included; otherwise the remaining model context. */
  maxTokens?: number
  /** Legacy alias for maxTokens. */
  max_new_tokens?: number
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
 * `enable_thinking`). `never`: a listed model that doesn't reason.
 */
type ResolveReasoning<TModel extends string> =
  TModel extends keyof TransformersJsModelReasoningByName
    ? TransformersJsModelReasoningByName[TModel]
    : TModel extends TransformersJsListedModel
      ? never
      : { levels: "off" | "high"; budget: true }

/** Sampling for a model this package doesn't list. */
const DEFAULT_SAMPLING: Sampling = {
  temperature: 0.7,
  top_k: 50,
  repetition_penalty: 1
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

function outputTokens(options: TransformersJsTextProviderOptions | undefined) {
  const limit = options?.maxTokens ?? options?.max_new_tokens
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new RangeError("maxTokens must be a nonnegative safe integer.")
  return limit
}

/** Cancel the caller's wait without discarding an in-progress model download. */
function waitForModel(model: string, dtype: WeightsDtype, contextLength: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  const loading = loadModel(model, dtype, contextLength)
  if (!signal) return loading
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    loading.then(() => {
      signal.removeEventListener("abort", aborted)
      if (signal.aborted) reject(signal.reason)
      else resolve()
    }, error => {
      signal.removeEventListener("abort", aborted)
      reject(error)
    })
  })
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

let calls = 0
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(calls++).toString(36)}`

export class TransformersJsTextAdapter<
  TModel extends string
> extends BaseTextAdapter<
  TModel,
  TransformersJsTextProviderOptions,
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

  constructor(config: TransformersJsTextConfig, model: TModel) {
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
    if (config.debug) setDebug(true)
    setKeepLoaded(model, config.keepLoaded ?? false)
  }

  /** Sampling for a call: `modelOptions` over the model card's or the defaults. */
  private sampling(
    modelOptions: TransformersJsTextProviderOptions | undefined
  ) {
    const base = modelMeta(this.model)?.sampling ?? DEFAULT_SAMPLING
    const top_p = modelOptions?.top_p ?? base.top_p
    return {
      temperature: modelOptions?.temperature ?? base.temperature,
      top_k: modelOptions?.top_k ?? base.top_k,
      repetition_penalty:
        modelOptions?.repetition_penalty ?? base.repetition_penalty,
      ...(top_p !== undefined && { top_p })
    }
  }

  async *chatStream(
    options: TextOptions<TransformersJsTextProviderOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const threadId = options.threadId
    const callId = nextId("call")
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal =
      options.abortController?.signal ??
      (options.request as RequestInit | undefined)?.signal ??
      undefined
    const model = this.model
    const sampling = this.sampling(options.modelOptions)
    const thinking = thinkingOptions(options.reasoning, model)
    const maxTokens = outputTokens(options.modelOptions)
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
      await waitForModel(model, this.dtype, this.contextLength, signal)
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
    const parsed = markup && options.tools?.length && options.toolChoice !== "none" ? parseToolCalls(markup) : []
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
   * hook. `chat()` additionally validates the completed result.
   */
  async structuredOutput(
    options: StructuredOutputOptions<TransformersJsTextProviderOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = chatOptions.abortController?.signal ?? (chatOptions.request as RequestInit | undefined)?.signal ?? undefined
    const thinking = thinkingOptions(chatOptions.reasoning, this.model)
    const maxTokens = outputTokens(chatOptions.modelOptions)
    await waitForModel(this.model, this.dtype, this.contextLength, signal)
    signal?.throwIfAborted()
    const system = normalizeSystemPrompts(chatOptions.systemPrompts)
      .map((p) => p.content)
      .concat(
        `Answer with only a JSON value matching this JSON Schema:\n${JSON.stringify(outputSchema)}`
      )
      .join("\n\n")
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
      sampling: this.sampling(chatOptions.modelOptions),
      maxTokens,
      contextLength: this.contextLength,
      thinkingOpen: THINKING_MARKERS[this.toolFormat].open,
      thinkingClose: THINKING_MARKERS[this.toolFormat].close,
      signal: signal
    })
    let raw = ""
    let next = await stream.next()
    try {
      while (!next.done) {
        signal?.throwIfAborted()
        raw += next.value
        next = await stream.next()
      }
    } finally {
      if (!next.done) await stream.return({})
    }
    signal?.throwIfAborted()
    if (next.value.failure) throw new Error(next.value.failure)
    const rawText = structuredAnswer(raw, THINKING_MARKERS[this.toolFormat])
    signal?.throwIfAborted()
    const json = rawText.replace(/^```(?:json)?\s*|\s*```$/g, "")
    try {
      return {
        data: JSON.parse(json) as unknown,
        rawText,
        ...(next.value.stats && { usage: usageOf(next.value.stats) })
      }
    } catch {
      throw new Error(
        `The model's answer isn't JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? "…" : ""}`
      )
    }
  }
}

/**
 * A TanStack AI text adapter for a Transformers.js model in the browser: a
 * model this package lists (`TRANSFORMERS_JS_TEXT_MODELS`), which needs no
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
  ...[config]: TModel extends TransformersJsListedModel
    ? [config?: TransformersJsTextConfigFor<TModel>]
    : [config: TransformersJsTextConfigFor<TModel>]
): TransformersJsTextAdapter<TModel> {
  return new TransformersJsTextAdapter(config ?? {}, model)
}
