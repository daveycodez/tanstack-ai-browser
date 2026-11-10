/**
 * A TanStack AI embedding adapter for WebLLM's embedding models, shaped like
 * TanStack's own (`@tanstack/ai-openai`'s `openaiEmbedding`):
 * `embed({ adapter: webLlmEmbedding(), input })`. WebLLM answers OpenAI's
 * embeddings API in the page, so the request is OpenAI's, sent to WebLLM's
 * `embeddings.create`. Embedding models load in their own engine, so they
 * don't unload the chat model.
 */
import { requireTextOnlyEmbeddingInput } from "@tanstack/ai"
import type { EmbeddingOptions, EmbeddingResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseEmbeddingAdapter } from "@tanstack/ai/adapters"
import type { AppConfig, EmbeddingCreateParams, MLCEngineConfig } from "@mlc-ai/web-llm"

import { engineFor } from "./client.js"
import type { Availability, DownloadProgressCallback, EngineSlot, LoadSettings } from "./client.js"
import type { WebLlmEmbeddingModel } from "./catalog.js"

export type WebLlmEmbeddingConfig = {
  /** WebLLM's model list, for a model its catalog doesn't have. WebLLM's `prebuiltAppConfig` by default. */
  appConfig?: AppConfig
  /** WebLLM's engine config, applied when the model loads (see `webLlmText`'s). */
  engineConfig?: MLCEngineConfig
  /**
   * A Web Worker of your own to run WebLLM in (see `webLlmText`'s). It holds
   * one model: give the chat adapter another, or they unload each other.
   */
  worker?: Worker
  /** The model's download progress, 0 to 1, when a call starts its download; then 1 once it's ready. */
  onDownloadProgress?: DownloadProgressCallback
}

/** Per-call `modelOptions`: WebLLM's own embedding request fields, sent as given. */
export type WebLlmEmbeddingModelOptions = Omit<EmbeddingCreateParams, "input" | "model" | "dimensions">

/** A model WebLLM's catalog lists, or any `model_id` of the adapter's `appConfig`. */
export type WebLlmEmbeddingModelId = WebLlmEmbeddingModel | (string & {})

export class WebLlmEmbeddingAdapter<TModel extends WebLlmEmbeddingModelId> extends BaseEmbeddingAdapter<
  TModel,
  WebLlmEmbeddingModelOptions
> {
  readonly name = "web-llm" as const
  private readonly loadConfig: WebLlmEmbeddingConfig
  private readonly settings: LoadSettings
  /** The engine the model loads in: the package's for embedding, or the adapter's own worker's. */
  private readonly engine: EngineSlot

  constructor(config: WebLlmEmbeddingConfig, model: TModel) {
    super(model, {})
    this.loadConfig = config
    const { appConfig = config.engineConfig?.appConfig, engineConfig } = config
    this.settings = { ...(appConfig && { appConfig }), ...(engineConfig && { engineConfig }) }
    this.engine = engineFor("embedding", config.worker)
  }

  /** Where the model stands in this browser, with the Prompt API's values (see `webLlmText`'s). */
  availability(): Promise<Availability> {
    return this.engine.availability(this.model, this.settings.appConfig)
  }

  /** Downloads the model if it isn't stored and loads it, with the download's progress. Resolves to this adapter. */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    // It takes the engine's turn, so it never reloads the engine under another call.
    const ready = (async () => {
      const release = await this.engine.acquire(options.signal)
      try {
        await this.load(options.signal, options.onDownloadProgress)
        return this
      } finally {
        release()
      }
    })()
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, freeing its GPU memory, once the engine's current call ends. It stays in WebLLM's cache. */
  async destroy(): Promise<void> {
    const release = await this.engine.acquire()
    try {
      await this.engine.unloadModel(this.model)
    } finally {
      release()
    }
  }

  private load(signal?: AbortSignal, onDownloadProgress?: DownloadProgressCallback) {
    const own = this.loadConfig.onDownloadProgress
    return this.engine.loadModel(this.model, this.settings, {
      ...((own || onDownloadProgress) && {
        onDownloadProgress: (progress: number) => {
          own?.(progress)
          onDownloadProgress?.(progress)
        }
      }),
      ...(signal && { signal })
    })
  }

  async createEmbeddings(options: EmbeddingOptions<WebLlmEmbeddingModelOptions>): Promise<EmbeddingResult> {
    const { logger, modelOptions } = options
    const model = options.model as TModel
    try {
      const texts = requireTextOnlyEmbeddingInput(options.input, this.name, model)
      if (options.dimensions !== undefined) {
        throw new Error(`WebLLM's embedding models return their own size of vector: leave \`dimensions\` out.`)
      }
      logger.request(`activity=embed provider=${this.name} model=${model} inputs=${texts.length}`, { provider: this.name, model })
      // The engine is this batch's from its load to its end, so another
      // adapter's preload or unload waits for it.
      const release = await this.engine.acquire(options.abortSignal)
      const response = await this.load(options.abortSignal)
        .then((engine) => engine.embeddings.create({ ...modelOptions, model, input: texts }))
        .finally(release)
      return {
        id: this.generateId(this.name),
        model,
        embeddings: response.data.map((item) => ({ vector: item.embedding as Array<number>, index: item.index })),
        usage: { promptTokens: response.usage.prompt_tokens, completionTokens: 0, totalTokens: response.usage.total_tokens }
      }
    } catch (error) {
      logger.errors(`${this.name}.createEmbeddings fatal`, {
        error: toRunErrorPayload(error, `${this.name}.createEmbeddings failed`),
        source: `${this.name}.createEmbeddings`
      })
      throw error
    }
  }
}

/**
 * A TanStack AI embedding adapter for a model WebLLM runs in the browser, on
 * WebGPU: Snowflake's Arctic Embed S by default, WebLLM's smallest (about
 * 240 MB; 384 numbers a vector).
 *
 * @example
 * ```ts
 * const { embeddings } = await embed({ adapter: webLlmEmbedding(), input: ["a red guitar", "a blue drum kit"] })
 * ```
 */
export function webLlmEmbedding<TModel extends WebLlmEmbeddingModelId = "snowflake-arctic-embed-s-q0f32-MLC-b4">(
  model: TModel = "snowflake-arctic-embed-s-q0f32-MLC-b4" as TModel,
  config: WebLlmEmbeddingConfig = {}
): WebLlmEmbeddingAdapter<TModel> {
  return new WebLlmEmbeddingAdapter(config, model)
}
