/**
 * A TanStack AI text adapter for webgllm: LFM3, LFM2.5 and Qwen3.5 on
 * WebGL 2 in a Web Worker, for browsers without WebGPU. webgllm answers
 * OpenAI's Chat Completions API in the page, so this is TanStack's Chat
 * Completions adapter with the shared `WebGLLM` instance as its client:
 * messages, tools, structured output and the stream (text, thinking, tool
 * calls) are TanStack's. This file adds what's webgllm's own: loading the
 * model before a call, its reasoning levels and thinking budget, and its
 * sampling options.
 */
import type { AdapterYieldChunk, ModelReasoning, TextOptions } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"
import { OpenAIBaseChatCompletionsTextAdapter } from "@tanstack/openai-base"
import type { OpenAIClientLike } from "@tanstack/openai-base"

import { modelMeta } from "./catalog.js"
import type { WebGllmChatModel, WebGllmModelReasoningByName } from "./catalog.js"
import { availability, ensureModel, loadModel, setKeepLoaded, touchModel, unloadModel, webgllm } from "./models.js"
import type { Availability, DownloadProgressCallback } from "./models.js"

/**
 * Per-call `modelOptions`, named like TanStack's OpenRouter adapter's, and
 * sent with webgllm's (OpenAI's) names.
 */
export type WebGllmTextModelOptions = {
  /** Maximum generated tokens, thinking included; otherwise EOS or remaining context. */
  maxCompletionTokens?: number
  temperature?: number
  topP?: number
  presencePenalty?: number
  /** Not supported by webgllm: anything but 0 is refused with its `unsupported-parameter` error. */
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
   * Applies once the adapter uses the model (`create()` or a call); left
   * out, the model keeps what another adapter of it set.
   */
  keepLoaded?: boolean
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

type ResolveReasoning<TModel extends string> = TModel extends keyof WebGllmModelReasoningByName
  ? WebGllmModelReasoningByName[TModel]
  : never

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

/** A Chat Completions request, as the base adapter writes it. */
type CreateParams = Parameters<OpenAIClientLike["chat"]["completions"]["create"]>[0]

/** The engine as an OpenAI client: Chat Completions is all the adapter calls. */
const client = {
  baseURL: "webgllm:",
  chat: {
    completions: {
      create: (body: unknown, options?: { signal?: AbortSignal | null }) =>
        webgllm.chat.completions.create(body as never, options?.signal ? { signal: options.signal } : {})
    }
  }
} as unknown as OpenAIClientLike

/**
 * A model's reasoning levels with webgllm's `reasoning_effort` values: its
 * catalog gives the template's switch ("true", "false").
 */
function effortLevels(model: WebGllmChatModel): ModelReasoning | undefined {
  const reasoning = modelMeta(model).reasoning
  if (!reasoning) return undefined
  const levels = Object.fromEntries(
    Object.entries(reasoning.levels).map(([level, value]) => [level, value === "false" ? "none" : "high"])
  )
  return { ...reasoning, levels } as ModelReasoning
}

/** `modelOptions` with webgllm's names. */
function toRequestOptions(o: WebGllmTextModelOptions | undefined): Record<string, unknown> {
  const fields = {
    max_completion_tokens: o?.maxCompletionTokens,
    temperature: o?.temperature,
    top_p: o?.topP,
    top_k: o?.topK,
    min_p: o?.minP,
    repetition_penalty: o?.repetitionPenalty,
    presence_penalty: o?.presencePenalty,
    frequency_penalty: o?.frequencyPenalty,
    stop: o?.stop,
    seed: o?.seed,
    parallel_tool_calls: o?.parallelToolCalls,
    repair_tool_calls: o?.repairToolCalls
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

const signalOf = (options: TextOptions) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class WebGllmTextAdapter<TModel extends WebGllmChatModel> extends OpenAIBaseChatCompletionsTextAdapter<
  TModel,
  WebGllmTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  ResolveReasoning<TModel>
> {
  override readonly name = "webgllm"
  override readonly api = "webgllm"
  override readonly inputModalities = ["text"] as const

  private readonly contextLength: number | undefined
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  private readonly keepLoaded: boolean | undefined

  constructor(config: WebGllmConfig, model: TModel) {
    super(model, "webgllm", client, { strictFallbackWarning: false })
    this.contextLength = config.contextLength
    this.onDownloadProgress = config.onDownloadProgress
    this.keepLoaded = config.keepLoaded
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where the engine can't run (WebGL 2 with float render
   * targets, in a worker; not on a server; checked once per page),
   * "downloading" while this page downloads it, "available" when it's
   * loaded for this adapter's `contextLength` or its files are all in
   * webgllm's storage, else "downloadable". It reads storage only.
   */
  availability(): Promise<Availability> {
    return availability(this.model, this.contextLength)
  }

  /**
   * Loads the model for this adapter's `contextLength` (downloading it the
   * first time), with the download's progress, 0 to 1, then 1 once it's
   * ready. Resolves to this adapter; rejects if it can't load (fine to leave
   * unawaited). `chat()` doesn't need it: its first call loads the model.
   * Aborting `signal` rejects at once; webgllm cancels the load if nothing
   * else waits on it.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const own = this.onDownloadProgress
    const theirs = options.onDownloadProgress
    this.useModel()
    const ready = loadModel(this.model, {
      contextLength: this.contextLength,
      ...(options.signal && { signal: options.signal }),
      onDownloadProgress:
        own && theirs
          ? (progress) => {
              own(progress)
              theirs(progress)
            }
          : (own ?? theirs)
    }).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model for every adapter of it, freeing its GPU memory. Its files stay. Never rejects. */
  destroy(): Promise<void> {
    return unloadModel(this.model)
  }

  /** Applies this adapter's `keepLoaded` when it uses the model, not when it's constructed. */
  private useModel() {
    if (this.keepLoaded !== undefined) setKeepLoaded(this.model, this.keepLoaded)
  }

  /** Loads the model if it isn't, for this adapter's context length. */
  private async ready(options: TextOptions) {
    this.useModel()
    await ensureModel(this.model, this.contextLength, signalOf(options), this.onDownloadProgress)
    touchModel(this.model)
  }

  override async *chatStream(options: TextOptions<WebGllmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    await this.ready(options)
    yield* super.chatStream(options)
  }

  override async *structuredOutputStream(options: StructuredOutputOptions<WebGllmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    await this.ready(options.chatOptions)
    yield* super.structuredOutputStream(options)
  }

  override async structuredOutput(options: StructuredOutputOptions<WebGllmTextModelOptions>): Promise<StructuredOutputResult<unknown>> {
    await this.ready(options.chatOptions)
    return super.structuredOutput(options)
  }

  /** The request, with webgllm's option names, thinking budget and prompt cache. */
  protected override mapOptionsToRequest(options: TextOptions): CreateParams & { stream: true } {
    const modelOptions = options.modelOptions as WebGllmTextModelOptions | undefined
    const request = super.mapOptionsToRequest({ ...options, modelOptions: toRequestOptions(modelOptions) })
    const resolved = resolveReasoning(options.reasoning, effortLevels(this.model))
    const budget = resolved?.value === "high" ? resolved.budgetTokens : undefined
    return Object.assign(request, {
      ...(budget !== undefined && { thinking_budget_tokens: budget }),
      ...(options.promptCache?.retention === "none" && { cache_prompt: false })
    })
  }

  protected override modelReasoning(model: string) {
    return effortLevels(model as WebGllmChatModel)
  }

  /** webgllm streams thinking as `reasoning_content`. */
  protected override extractReasoning(chunk: unknown) {
    const text = (chunk as { choices?: Array<{ delta?: { reasoning_content?: string } }> }).choices?.[0]?.delta
      ?.reasoning_content
    return text ? { text } : undefined
  }

  /** Schemas as given: webgllm constrains to any JSON Schema, without OpenAI's strict-mode rewrite. */
  protected override makeStructuredOutputCompatible(schema: Record<string, any>) {
    return schema
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
export function webgllmText<TModel extends WebGllmChatModel>(model: TModel, config?: WebGllmConfig): WebGllmTextAdapter<TModel> {
  return new WebGllmTextAdapter(config ?? {}, model)
}
