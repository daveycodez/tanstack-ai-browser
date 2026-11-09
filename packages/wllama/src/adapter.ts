/**
 * A TanStack AI text adapter for GGUF models that run in the browser with
 * wllama (llama.cpp in WebAssembly). wllama answers llama.cpp's
 * OpenAI-compatible Chat Completions API in the page, so this is TanStack's
 * Chat Completions adapter with the loaded model as its client: messages,
 * tools, structured output and the stream (text, thinking, tool calls) are
 * TanStack's, and llama.cpp writes the prompt with the model's chat template
 * and reads its thinking and tool calls back. This file adds what's wllama's
 * own: loading the model, the chat template's thinking switch, llama.cpp's
 * sampling settings.
 */
import type { AdapterYieldChunk, ReasoningRequest, TextOptions } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"
import { OpenAIBaseChatCompletionsTextAdapter } from "@tanstack/openai-base"
import type { OpenAIClientLike } from "@tanstack/openai-base"
import type { WllamaCompat } from "@wllama/wllama/esm/index.js"

import {
  availability,
  completeChat,
  configureRuntime,
  loadModel,
  setContextLength,
  setKeepLoaded,
  streamChat,
  unloadModel,
  waitForModel
} from "./client.js"
import type { Availability, ChatRequest, DownloadProgressCallback } from "./client.js"
import { modelMeta } from "./catalog.js"
import type { Sampling, WllamaChatModel, WllamaModelReasoningByName } from "./catalog.js"

export type WllamaConfig = {
  /**
   * Most tokens a chat may hold, prompt and reply together: the model's
   * whole context window by default (its GGUF's training context), never
   * more. llama.cpp reserves the attention cache for all of it when the
   * model loads (LFM3: ~12 KB a token, so 3 GB for its 262,144), so set
   * less where memory is short: 8,192 on an iPhone. Changing it loads the
   * model again.
   */
  contextLength?: number
  /**
   * Keeps the model loaded when another runtime (Transformers.js, WebGL)
   * loads one past the page's memory budget (see `setMemoryBudget`); by
   * default the least recently used model is unloaded to make room.
   * Applies once the adapter uses the model (`create()` or a call); left
   * out, the model keeps what another adapter of it set.
   */
  keepLoaded?: boolean
  /**
   * Where wllama's WebAssembly file is served. By default, the installed
   * `@wllama/wllama`'s own file on jsDelivr, at its version; serve
   * `@wllama/wllama/esm/wasm/wllama.wasm` with the site and pass its URL to
   * host it yourself. Applies to every model.
   */
  wasmUrl?: string
  /**
   * Where wllama's compat build (for Safari: `@wllama/wllama-compat`'s
   * `wasm/wllama.wasm` and `wasm/wllama.js`) is served, passed to
   * `Wllama.setCompat`. By default, wllama's: the same version on jsDelivr.
   */
  compat?: WllamaCompat
  /** CPU threads. wllama's default otherwise: half the cores. */
  threads?: number
  /**
   * `false` to run on the CPU only. By default wllama runs on WebGPU where
   * it can, and on the CPU elsewhere.
   */
  gpu?: boolean
  /** wllama's and llama.cpp's logs, in the console. */
  debug?: boolean
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Per-call `modelOptions`, named as OpenRouter's adapter names them, so an
 * app can swap this adapter for `@tanstack/ai-openrouter`'s unchanged;
 * mapped to llama.cpp's own settings. Sampling left out comes from the
 * model card.
 */
export type WllamaTextModelOptions = {
  /** Most tokens to generate, thinking included. llama.cpp's default otherwise: up to the context limit. */
  maxCompletionTokens?: number
  /** Randomness of sampling: 0 is greedy. */
  temperature?: number
  /** Nucleus sampling: the likeliest tokens up to this probability, in (0, 1]. */
  topP?: number
  /** Lowers the odds of tokens by how often they've appeared (llama.cpp's `frequency_penalty`). */
  frequencyPenalty?: number
  /** Lowers the odds of tokens that have appeared at all (llama.cpp's `presence_penalty`). */
  presencePenalty?: number
  /** Seeds the sampler, for the same samples from the same request. */
  seed?: number
  /** Where to stop: the reply ends before the first of these it would write. */
  stop?: string | Array<string>
  /** Sampling from the likeliest `topK` tokens only (0: all of them). */
  topK?: number
  /** Drops tokens less likely than this share of the likeliest one's odds (llama.cpp's `min_p`). */
  minP?: number
  /** Penalizes tokens already in the chat (llama.cpp's `repeat_penalty`; 1: off). */
  repetitionPenalty?: number
  /**
   * False keeps a reply to one tool call (llama.cpp's `parallel_tool_calls`,
   * which constrains the model to a single call). True or left out: as many
   * as the model writes, when its chat template supports several.
   */
  parallelToolCalls?: boolean
}

/** The reasoning levels of a model, for `chat({ reasoning })`; `never` for one that doesn't reason. */
type ResolveReasoning<TModel extends string> = TModel extends keyof WllamaModelReasoningByName
  ? WllamaModelReasoningByName[TModel]
  : never

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

/** A Chat Completions request, as the base adapter writes it. */
type CreateParams = Parameters<OpenAIClientLike["chat"]["completions"]["create"]>[0]

/**
 * The chat template's `enable_thinking` for a request, through llama.cpp's
 * `chat_template_kwargs`, and a thinking budget: left out when the model has
 * no levels or the request doesn't ask, so the template's default applies.
 */
function thinkingKwargs(request: ReasoningRequest | undefined, model: WllamaChatModel): Partial<ChatRequest> {
  const value = resolveReasoning(request, modelMeta(model).reasoning)?.value
  if (value === undefined) return {}
  const thinking = value === "true"
  const budget = request?.budgetTokens
  return {
    chat_template_kwargs: { enable_thinking: thinking },
    ...(thinking && budget !== undefined && { reasoning_budget_tokens: budget })
  }
}

/** `modelOptions` with llama.cpp's names, over the model card's sampling. */
function llamaSettings(options: WllamaTextModelOptions | undefined, base: Sampling): Record<string, unknown> {
  const o = options ?? {}
  const fields = {
    temperature: o.temperature ?? base.temperature,
    top_k: o.topK ?? base.topK,
    repeat_penalty: o.repetitionPenalty ?? base.repetitionPenalty,
    top_p: o.topP ?? base.topP,
    min_p: o.minP,
    frequency_penalty: o.frequencyPenalty,
    presence_penalty: o.presencePenalty,
    seed: o.seed,
    stop: o.stop,
    max_tokens: o.maxCompletionTokens
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

/** The loaded model as an OpenAI client: Chat Completions is all the adapter calls. */
function clientFor(model: WllamaChatModel): OpenAIClientLike {
  const create = (body: Record<string, unknown>, options?: { signal?: AbortSignal | null }) => {
    const signal = options?.signal ?? undefined
    const { stream, ...request } = body
    return stream ? streamChat(model, request as ChatRequest, signal) : completeChat(model, request as ChatRequest, signal)
  }
  return { baseURL: "wllama:", chat: { completions: { create } } } as unknown as OpenAIClientLike
}

const signalOf = (options: TextOptions) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class WllamaTextAdapter<TModel extends WllamaChatModel> extends OpenAIBaseChatCompletionsTextAdapter<
  TModel,
  WllamaTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  ResolveReasoning<TModel>
> {
  override readonly name = "wllama"
  override readonly api = "wllama"
  override readonly inputModalities = ["text"] as const

  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  private readonly loadConfig: WllamaConfig

  constructor(config: WllamaConfig, model: TModel) {
    super(model, "wllama", clientFor(model), { strictFallbackWarning: false })
    this.onDownloadProgress = config.onDownloadProgress
    this.loadConfig = config
  }

  /**
   * Applies this adapter's settings when it uses the model, not when it's
   * constructed: constructing an adapter changes nothing shared.
   */
  private useModel() {
    const config = this.loadConfig
    setContextLength(this.model, config.contextLength)
    if (config.keepLoaded !== undefined) setKeepLoaded(this.model, config.keepLoaded)
    configureRuntime({
      ...(config.wasmUrl && { wasmUrl: config.wasmUrl }),
      ...(config.compat && { compat: config.compat }),
      ...(config.threads && { threads: config.threads }),
      ...(config.gpu !== undefined && { gpu: config.gpu }),
      ...(config.debug && { debug: true })
    })
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "available" once it's in the browser's cache (or loaded),
   * "downloading" while this page downloads it, else "downloadable";
   * "unavailable" where wllama can't run.
   */
  availability(): Promise<Availability> {
    return availability(this.model)
  }

  /**
   * Downloads the model if it isn't cached and loads it, with the download's
   * progress, 0 to 1, then 1 once it's ready. Resolves to this adapter;
   * rejects if it can't load (fine to leave unawaited). `chat()` doesn't
   * need it: its first call loads the model.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const own = this.onDownloadProgress
    const theirs = options.onDownloadProgress
    this.useModel()
    const ready = loadModel(
      this.model,
      own && theirs
        ? (progress) => {
            own(progress)
            theirs(progress)
          }
        : (own ?? theirs),
      options.signal ? { signal: options.signal } : {}
    ).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, freeing its memory. It stays in the browser's cache. */
  async destroy(): Promise<void> {
    await unloadModel(this.model)
  }

  /** Loads the model if it isn't, with this adapter's settings. */
  private async ready(options: TextOptions) {
    this.useModel()
    await waitForModel(this.model, signalOf(options), this.onDownloadProgress)
  }

  override async *chatStream(options: TextOptions<WllamaTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    await this.ready(options)
    yield* super.chatStream(options)
  }

  override async *structuredOutputStream(options: StructuredOutputOptions<WllamaTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    await this.ready(options.chatOptions)
    yield* super.structuredOutputStream(options)
  }

  override async structuredOutput(options: StructuredOutputOptions<WllamaTextModelOptions>): Promise<StructuredOutputResult<unknown>> {
    await this.ready(options.chatOptions)
    return super.structuredOutput(options)
  }

  /** The request, with llama.cpp's settings over the model card's, and the chat template's thinking switch. */
  protected override mapOptionsToRequest(options: TextOptions): CreateParams & { stream: true } {
    const modelOptions = options.modelOptions as WllamaTextModelOptions | undefined
    const settings = {
      ...llamaSettings(modelOptions, modelMeta(this.model).sampling),
      ...(modelOptions?.parallelToolCalls !== undefined && options.tools?.length && { parallel_tool_calls: modelOptions.parallelToolCalls }),
      ...(options.promptCache?.retention === "none" && { cache_prompt: false })
    }
    const request = super.mapOptionsToRequest({ ...options, modelOptions: settings, reasoning: undefined })
    return Object.assign(request, thinkingKwargs(options.reasoning, this.model))
  }

  /** llama.cpp streams thinking as `reasoning_content`. */
  protected override extractReasoning(chunk: unknown) {
    const text = (chunk as { choices?: Array<{ delta?: { reasoning_content?: string } }> }).choices?.[0]?.delta?.reasoning_content
    return text ? { text } : undefined
  }

  /** Schemas as given: llama.cpp's grammar takes any JSON Schema, without OpenAI's strict-mode rewrite. */
  protected override makeStructuredOutputCompatible(schema: Record<string, any>) {
    return schema
  }
}

/**
 * A TanStack AI text adapter for a GGUF model that wllama runs in the
 * browser.
 *
 * @example
 * ```ts
 * chat({ adapter: wllamaText("unsloth/Qwen3.5-2B-GGUF"), messages, threadId })
 * ```
 */
export function wllamaText<TModel extends WllamaChatModel>(
  model: TModel,
  config: WllamaConfig = {}
): WllamaTextAdapter<TModel> {
  return new WllamaTextAdapter(config, model)
}
