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
import type { AppConfig, EmbeddingCreateParams } from "@mlc-ai/web-llm"

import { embeddingEngine } from "./client.js"
import type { Availability, DownloadProgressCallback } from "./client.js"
import type { WebLlmEmbeddingModel } from "./catalog.js"

export type WebLlmEmbeddingConfig = {
  /** WebLLM's model list, for a model its catalog doesn't have. WebLLM's `prebuiltAppConfig` by default. */
  appConfig?: AppConfig
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

  constructor(config: WebLlmEmbeddingConfig, model: TModel) {
    super(model, {})
    this.loadConfig = config
  }

  /** Where the model stands in this browser, with the Prompt API's values (see `webLlmText`'s). */
  availability(): Promise<Availability> {
    return embeddingEngine.availability(this.model, this.loadConfig.appConfig)
  }

  /** Downloads the model if it isn't stored and loads it, with the download's progress. Resolves to this adapter. */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const ready = this.load(options.signal, options.onDownloadProgress).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, freeing its GPU memory. It stays in WebLLM's cache. */
  async destroy(): Promise<void> {
    await embeddingEngine.unloadModel(this.model)
  }

  private load(signal?: AbortSignal, onDownloadProgress?: DownloadProgressCallback) {
    const own = this.loadConfig.onDownloadProgress
    return embeddingEngine.loadModel(this.model, { ...(this.loadConfig.appConfig && { appConfig: this.loadConfig.appConfig }) }, {
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
      const engine = await this.load(options.abortSignal)
      const response = await engine.embeddings.create({ ...modelOptions, model, input: texts })
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
