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
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
  CompletionTimings,
  CompletionUsage,
  FinishReason
} from "webgllm"
import type { GenerationPhase } from "webgllm/advanced"

import { modelMeta } from "./catalog.js"
import type { WebGlModelReasoningByName, WebGlTextModel } from "./catalog.js"
import { ensureModel, reconcile, setKeepLoaded, touchModel, webgllm } from "./models.js"

/** Per-call `modelOptions`: sampling over the model card's, and the most tokens to generate. */
export type WebGllmTextProviderOptions = {
  /** Maximum generated tokens, thinking included; otherwise EOS or remaining context. */
  maxTokens?: number
  /** Legacy alias for maxTokens. maxTokens takes precedence when both are supplied. */
  max_new_tokens?: number
  temperature?: number
  top_k?: number
  top_p?: number
  min_p?: number
  repetition_penalty?: number
  presence_penalty?: number
  /** Text that ends the reply where it appears (not included). */
  stop?: string | Array<string>
  /** Makes sampling repeatable. */
  seed?: number
  /** False returns tool calls as the model wrote them, without webgllm's repair. Default true. */
  repair_tool_calls?: boolean
  /** False keeps only the first tool call of a reply. */
  parallel_tool_calls?: boolean
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
export type WebGllmTextConfig = {
  /**
   * When the model starts reading the prompt ("processing", once it's
   * loaded and the request is sent) and writing ("generating", at the first
   * streamed text or thinking).
   */
  onGenerationPhase?: (phase: GenerationPhase) => void
  /** Model-generated thinking text as it streams, in chats and structured output alike. */
  onThinking?: (delta: string) => void
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
}

type ResolveReasoning<TModel extends string> = TModel extends keyof WebGlModelReasoningByName
  ? WebGlModelReasoningByName[TModel]
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
  model: WebGlTextModel
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
function outputTokens(options: WebGllmTextProviderOptions | undefined) {
  const limit = options?.maxTokens ?? options?.max_new_tokens
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError("maxTokens must be a nonnegative safe integer.")
  }
  return limit
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

const signalOf = (options: TextOptions<WebGllmTextProviderOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class WebGllmTextAdapter<TModel extends WebGlTextModel> extends BaseTextAdapter<
  TModel,
  WebGllmTextProviderOptions,
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
  private readonly onGenerationPhase: WebGllmTextConfig["onGenerationPhase"]
  private readonly onThinking: WebGllmTextConfig["onThinking"]

  constructor(model: TModel, config: WebGllmTextConfig = {}) {
    super({}, model)
    this.contextLength = config.contextLength
    this.onGenerationPhase = config.onGenerationPhase
    this.onThinking = config.onThinking
    setKeepLoaded(model, config.keepLoaded ?? false)
  }

  /** The request body shared by chats and structured output (tools and schema aside). */
  private body(options: TextOptions<WebGllmTextProviderOptions>): ChatCompletionCreateParamsStreaming {
    const o = options.modelOptions
    const maxTokens = outputTokens(o)
    return {
      model: this.model,
      messages: toMessages(options.systemPrompts, options.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...reasoningFields(options.reasoning, this.model),
      ...(maxTokens !== undefined && { max_completion_tokens: maxTokens }),
      ...(o?.temperature !== undefined && { temperature: o.temperature }),
      ...(o?.top_k !== undefined && { top_k: o.top_k }),
      ...(o?.top_p !== undefined && { top_p: o.top_p }),
      ...(o?.min_p !== undefined && { min_p: o.min_p }),
      ...(o?.repetition_penalty !== undefined && { repetition_penalty: o.repetition_penalty }),
      ...(o?.presence_penalty !== undefined && { presence_penalty: o.presence_penalty }),
      ...(o?.stop !== undefined && { stop: o.stop }),
      ...(o?.seed !== undefined && { seed: o.seed }),
      ...(options.promptCache?.retention === "none" && { cache_prompt: false })
    }
  }

  /**
   * Streams the request once the model is loaded for this adapter's context
   * (webgllm would load it on demand, but for the instance's context).
   */
  private async request(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal | undefined
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    await ensureModel(this.model, this.contextLength, signal)
    signal?.throwIfAborted()
    touchModel(this.model)
    this.phase("processing", signal)
    return webgllm.chat.completions.create(body, { ...(signal && { signal }) })
  }

  private phase(phase: GenerationPhase, signal: AbortSignal | undefined) {
    if (!signal?.aborted) this.onGenerationPhase?.(phase)
  }

  async *chatStream(options: TextOptions<WebGllmTextProviderOptions>): AsyncIterable<AdapterYieldChunk> {
    const offered = options.toolChoice === "none" ? [] : toTools(options.tools)
    const body: ChatCompletionCreateParamsStreaming = {
      ...this.body(options),
      ...(offered.length && { tools: offered }),
      ...(offered.length && options.toolChoice && { tool_choice: toToolChoice(options.toolChoice) }),
      ...(options.modelOptions?.repair_tool_calls !== undefined && {
        repair_tool_calls: options.modelOptions.repair_tool_calls
      }),
      ...(options.modelOptions?.parallel_tool_calls !== undefined && {
        parallel_tool_calls: options.modelOptions.parallel_tool_calls
      })
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
      await ensureModel(model, this.contextLength, signal)
    } catch (error) {
      if (isAbort(error, signal)) return
      yield runError(model, error, true)
      return
    }

    let reasoning: "none" | "open" | "closed" = "none"
    let textStarted = false
    let text = ""
    let generating = false
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
      this.phase("processing", signal)
      const stream = await webgllm.chat.completions.create(body, { ...(signal && { signal }) })
      for await (const chunk of stream) {
        if (chunk.usage) usage = usageOf(chunk.usage, chunk.timings)
        const choice = chunk.choices[0]
        if (!choice) continue
        const { delta } = choice
        if (!generating && (delta.content || delta.reasoning_content || delta.tool_calls)) {
          generating = true
          this.phase("generating", signal)
        }
        if (delta.reasoning_content) {
          if (!signal?.aborted) this.onThinking?.(delta.reasoning_content)
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
      void reconcile()
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
   * A JSON answer for `chat({ outputSchema })`: the model is asked for JSON
   * matching the schema, webgllm constrains its answer to it, and the answer
   * is parsed (`chat()` validates it).
   */
  async structuredOutput(
    options: StructuredOutputOptions<WebGllmTextProviderOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
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
    signal?.throwIfAborted()
    let rawText = ""
    let usage: TokenUsage | undefined
    let generating = false
    try {
      for await (const chunk of await this.request(body, signal)) {
        if (chunk.usage) usage = usageOf(chunk.usage, chunk.timings)
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (!generating && (delta.content || delta.reasoning_content)) {
          generating = true
          this.phase("generating", signal)
        }
        if (delta.reasoning_content && !signal?.aborted) this.onThinking?.(delta.reasoning_content)
        if (delta.content) rawText += delta.content
      }
    } finally {
      void reconcile()
    }
    signal?.throwIfAborted()
    try {
      return { data: JSON.parse(rawText) as unknown, rawText, ...(usage && { usage }) }
    } catch {
      throw new Error(
        `The model's answer isn't JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? "…" : ""}`
      )
    }
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
export function webgllmText<TModel extends WebGlTextModel>(
  model: TModel,
  config?: WebGllmTextConfig
): WebGllmTextAdapter<TModel> {
  return new WebGllmTextAdapter(model, config)
}
