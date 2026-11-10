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
import { WebGLLM } from "webgllm"
import type { LoadProgress } from "webgllm"

import { modelMeta, WEBGLLM_MODEL_META } from "./catalog.js"
import type { WebGllmChatModel, WebGllmModelReasoningByName } from "./catalog.js"

/**
 * Where a model stands in this browser, with the Prompt API's values
 * (`LanguageModel.availability()`).
 */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

/** The page's one engine, shared by every adapter. Exported for tests. */
export const webgllm = new WebGLLM()

let supported: boolean | undefined
/** Whether the engine runs here, checked once: webgllm's check makes a WebGL context. */
const engineRuns = () => (supported ??= WebGLLM.isSupported())

/** Models downloading in this page, from webgllm's events. */
const downloading = new Set<string>()
webgllm.addEventListener("progress", ({ model, phase, cached }) => {
  if (phase === "download" && !cached) downloading.add(model)
})
for (const type of ["load", "error", "unload"] as const) {
  webgllm.addEventListener(type, ({ model }) => downloading.delete(model))
}

/** The download's share of webgllm's load progress (downloading is its first 90%). */
const downloadShare = ({ progress, loadedBytes, totalBytes }: LoadProgress) =>
  totalBytes ? Math.min((loadedBytes ?? 0) / totalBytes, 1) : Math.min(progress / 0.9, 1)

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
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/** A model's reasoning levels: a listed model's, none for a listed one that doesn't reason, else the switch. */
type ResolveReasoning<TModel extends string> = TModel extends keyof WebGllmModelReasoningByName
  ? WebGllmModelReasoningByName[TModel]
  : TModel extends WebGllmChatModel
    ? never
    : { levels: "off" | "high"; budget: false }

/** A model the catalog lists, or any Hugging Face repo webgllm can resolve. */
export type WebGllmModel = WebGllmChatModel | (string & {})

/** The switch for a model the catalog doesn't list: webgllm's `reasoning_effort`, a hint it ignores where it can't apply. */
const UNLISTED_REASONING = { levels: { off: "none", high: "high" }, budget: false } as const

const listed = (model: string): model is WebGllmChatModel => Object.prototype.hasOwnProperty.call(WEBGLLM_MODEL_META, model)

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

/** A Chat Completions request, as the base adapter writes it. */
type CreateParams = Parameters<OpenAIClientLike["chat"]["completions"]["create"]>[0]

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

export class WebGllmTextAdapter<TModel extends WebGllmModel> extends OpenAIBaseChatCompletionsTextAdapter<
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

  constructor(config: WebGllmConfig, model: TModel) {
    // Chat Completions (`chat.completions.create`) is all the adapter calls.
    super(model, "webgllm", webgllm as unknown as OpenAIClientLike, { strictFallbackWarning: false })
    this.contextLength = config.contextLength
    this.onDownloadProgress = config.onDownloadProgress
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where the engine can't run (WebGL 2 with float render
   * targets, in a worker), "downloading" while this page downloads it,
   * "available" when it's loaded or its files are in webgllm's storage,
   * else "downloadable". It reads storage only.
   */
  async availability(): Promise<Availability> {
    if (!engineRuns()) return "unavailable"
    if (downloading.has(this.model)) return "downloading"
    const stored = await webgllm.models.downloaded(this.model).catch(() => false)
    return stored ? "available" : "downloadable"
  }

  /**
   * Loads the model for this adapter's `contextLength` (downloading it the
   * first time), with the download's progress, 0 to 1, then 1 once it's
   * ready. Resolves to this adapter; rejects if it can't load (fine to leave
   * unawaited). `chat()` doesn't need it: its first call loads the model.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const ready = this.load(options.signal, options.onDownloadProgress).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, freeing its GPU memory. Its files stay. Never rejects. */
  destroy(): Promise<void> {
    return webgllm.unloadModel(this.model).catch(() => undefined)
  }

  /**
   * Loads the model for this adapter's context length; webgllm returns at
   * once when it's loaded for it, and shares a load between its callers.
   */
  private async load(signal?: AbortSignal | null, onDownloadProgress?: DownloadProgressCallback) {
    const report = (progress: number) => {
      this.onDownloadProgress?.(progress)
      onDownloadProgress?.(progress)
    }
    await webgllm.loadModel(this.model, {
      ...(this.contextLength !== undefined && { contextLength: this.contextLength }),
      ...(signal && { signal }),
      onProgress: (progress) => {
        if (progress.phase === "download" && !progress.cached) report(downloadShare(progress))
      }
    })
    report(1)
  }

  override async *chatStream(options: TextOptions<WebGllmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    await this.load(signalOf(options))
    yield* super.chatStream(options)
  }

  override async *structuredOutputStream(options: StructuredOutputOptions<WebGllmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    await this.load(signalOf(options.chatOptions))
    yield* super.structuredOutputStream(options)
  }

  override async structuredOutput(options: StructuredOutputOptions<WebGllmTextModelOptions>): Promise<StructuredOutputResult<unknown>> {
    await this.load(signalOf(options.chatOptions))
    return super.structuredOutput(options)
  }

  /** The request, with webgllm's option names, thinking budget and prompt cache. */
  protected override mapOptionsToRequest(options: TextOptions): CreateParams & { stream: true } {
    const modelOptions = options.modelOptions as WebGllmTextModelOptions | undefined
    const request = super.mapOptionsToRequest({ ...options, modelOptions: toRequestOptions(modelOptions) })
    const resolved = resolveReasoning(options.reasoning, this.modelReasoning(this.model))
    const budget = resolved?.value === "high" ? resolved.budgetTokens : undefined
    return Object.assign(request, {
      ...(budget !== undefined && { reasoning: { max_tokens: budget } }),
      ...(options.promptCache?.retention === "none" && { cache_prompt: false })
    })
  }

  protected override modelReasoning(model: string) {
    return (listed(model) ? modelMeta(model).reasoning : UNLISTED_REASONING) as ModelReasoning | undefined
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
export function webgllmText<TModel extends WebGllmModel>(model: TModel, config?: WebGllmConfig): WebGllmTextAdapter<TModel> {
  return new WebGllmTextAdapter(config ?? {}, model)
}
