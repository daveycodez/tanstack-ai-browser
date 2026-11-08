/**
 * The embedding adapter, shaped like TanStack AI's own (`@tanstack/ai-openai`'s
 * and `@tanstack/ai-gemini`'s): `embed({ adapter: mediaPipeEmbedding(), input })`.
 */
import { requireTextOnlyEmbeddingInput } from "@tanstack/ai"
import type { EmbeddingOptions, EmbeddingResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseEmbeddingAdapter } from "@tanstack/ai/adapters"

import { availability, embedTexts, loadModel, unloadModel } from "./client.js"
import type { Availability, DownloadProgressCallback } from "./client.js"
import { MEDIAPIPE_MODEL_META } from "./model-meta.js"
import type {
  MediaPipeEmbeddingModel,
  MediaPipeEmbeddingModelInputModalitiesByName,
  MediaPipeEmbeddingModelProviderOptionsByName
} from "./model-meta.js"
import type {
  MediaPipeEmbeddingConfig,
  MediaPipeEmbeddingProviderOptions
} from "./options.js"

export type { MediaPipeEmbeddingConfig, MediaPipeEmbeddingProviderOptions }

/**
 * MediaPipe embedding adapter: text embeddings from Google's MediaPipe
 * TextEmbedder, in the browser, in a Web Worker.
 *
 * - One vector per input item, text only.
 * - Fixed dimensions (100 for Universal Sentence Encoder): `dimensions`
 *   set to anything else throws.
 * - `l2Normalize` and `quantize` through `modelOptions`.
 */
export class MediaPipeEmbeddingAdapter<
  TModel extends MediaPipeEmbeddingModel
> extends BaseEmbeddingAdapter<
  TModel,
  MediaPipeEmbeddingProviderOptions,
  MediaPipeEmbeddingModelProviderOptionsByName,
  MediaPipeEmbeddingModelInputModalitiesByName
> {
  readonly name = "mediapipe" as const
  protected loadConfig: MediaPipeEmbeddingConfig

  constructor(config: MediaPipeEmbeddingConfig, model: TModel) {
    super(model, {})
    this.loadConfig = config
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where MediaPipe can't run (its TextEmbedder needs
   * WebAssembly with SIMD in a module Web Worker; not on a server),
   * "available" when it's loaded and ready in this page (by any adapter
   * with the same model and equivalent options), else "downloadable", even
   * while it loads or when its files are in Cache Storage (a load then
   * reads them). It never says "downloading": progress comes from
   * `create`. It reads no storage and starts no worker.
   */
  availability(): Promise<Availability> {
    return availability(this.model, this.loadConfig)
  }

  /**
   * Loads the embedder (downloading the model the first time), with the
   * download's progress, 0 to 1, then 1 once it's ready. Resolves to this
   * adapter when it's ready; rejects if it can't load (fine to leave
   * unawaited). `embed()` doesn't need it (its first call loads the model),
   * but it lets a page load ahead of time. Adapters with the same model and
   * load options share one embedder; the page holds one at a time.
   * Aborting `signal` rejects this call at once with an AbortError and
   * stops its progress reports; if no other caller (another call, or an
   * `embed()` waiting for the model) still waits on the load, the worker
   * ends, its download with it, and the model is left unloaded.
   */
  create(
    options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
  ): Promise<this> {
    const { onDownloadProgress } = options
    const own = this.loadConfig.onDownloadProgress
    const ready = loadModel(
      this.model,
      this.loadConfig,
      own && onDownloadProgress
        ? (progress) => {
            own(progress)
            onDownloadProgress(progress)
          }
        : (own ?? onDownloadProgress),
      options.signal
    ).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /**
   * Unloads the embedder (ending its worker, and its download if it's
   * downloading), if it's this model's; requests waiting on it fail. The
   * embedder is shared, so this unloads it for every adapter of the model.
   * Its files stay in Cache Storage.
   */
  async destroySession(): Promise<void> {
    await unloadModel(this.model)
  }

  async createEmbeddings(
    options: EmbeddingOptions<MediaPipeEmbeddingProviderOptions>
  ): Promise<EmbeddingResult> {
    const { logger, modelOptions } = options
    const model = options.model as TModel
    try {
      const texts = requireTextOnlyEmbeddingInput(options.input, this.name, model)
      const expected = MEDIAPIPE_MODEL_META[model]?.dimensions
      const custom = this.loadConfig.modelAssetPath !== undefined
      // A custom model file's size is checked against what it returns.
      if (options.dimensions !== undefined && !custom && options.dimensions !== expected) {
        throw dimensionsError(model, options.dimensions, expected)
      }
      logger.request(
        `activity=embed provider=${this.name} model=${model} inputs=${texts.length}`,
        { provider: this.name, model }
      )
      const vectors =
        texts.length === 0
          ? []
          : await embedTexts(model, this.loadConfig, texts, {
              // Quantizing assumes unit-length vectors, so it normalizes
              // them unless told not to.
              l2Normalize: modelOptions?.l2Normalize ?? modelOptions?.quantize ?? false,
              quantize: modelOptions?.quantize ?? false
            }, this.loadConfig.onDownloadProgress)
      if (vectors.length !== texts.length) {
        throw new Error(
          `MediaPipe returned ${vectors.length} embeddings for ${texts.length} inputs (model: ${model}).`
        )
      }
      const returned = vectors[0]?.length
      if (options.dimensions !== undefined && returned !== undefined && returned !== options.dimensions) {
        throw dimensionsError(model, options.dimensions, returned)
      }
      return {
        id: this.generateId(this.name),
        model,
        embeddings: vectors.map((vector, index) => ({ vector: Array.from(vector), index }))
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

function dimensionsError(model: string, requested: number, fixed: number | undefined) {
  return new Error(
    `MediaPipe model "${model}" returns ${fixed ?? "a fixed number of"} dimensions and can't return ${requested}: leave \`dimensions\` out, or set it to ${fixed}.`
  )
}

/**
 * Creates a MediaPipe embedding adapter. Type resolution happens here at the
 * call site.
 *
 * @param model - The model's name: Universal Sentence Encoder by default
 * @param config - Load options: `delegate`, `modelAssetPath`, `wasmPath`
 *
 * @example
 * ```ts
 * const result = await embed({
 *   adapter: mediaPipeEmbedding(),
 *   input: ["a red guitar", "a blue drum kit"]
 * })
 * console.log(result.embeddings[0].vector) // 100 numbers
 * ```
 */
export function mediaPipeEmbedding<
  TModel extends MediaPipeEmbeddingModel = "universal-sentence-encoder"
>(
  model: TModel = "universal-sentence-encoder" as TModel,
  config: MediaPipeEmbeddingConfig = {}
): MediaPipeEmbeddingAdapter<TModel> {
  return new MediaPipeEmbeddingAdapter(config, model)
}
