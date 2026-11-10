/**
 * A TanStack AI embedding adapter for Transformers.js, shaped like TanStack's
 * own (`@tanstack/ai-openai`'s `openaiEmbedding`):
 * `embed({ adapter: transformersJsEmbedding(), input })`. It runs
 * Transformers.js's own `feature-extraction` pipeline on the page, as
 * browser-ai does; Transformers.js is imported the first time it's used.
 */
import { requireTextOnlyEmbeddingInput } from "@tanstack/ai"
import type { EmbeddingOptions, EmbeddingResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseEmbeddingAdapter } from "@tanstack/ai/adapters"
import type { FeatureExtractionPipeline, ProgressInfo } from "@huggingface/transformers"

import type { Availability, DownloadProgressCallback } from "./client.js"
import type { Device, Dtype } from "./protocol.js"

export type TransformersJsEmbeddingConfig = {
  /** "webgpu" or "wasm" (the CPU): Transformers.js's default otherwise. */
  device?: Device
  /** The ONNX weights to load: Transformers.js's default otherwise. */
  dtype?: Dtype
  /** The model's download progress, 0 to 1, then 1 once it's ready. */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Per-call `modelOptions`: the pipeline's own options (`pooling`,
 * `normalize`, `quantize`, `precision`), sent as given. Mean pooling and
 * normalized vectors by default, as sentence-transformers models expect.
 */
export type TransformersJsEmbeddingModelOptions = NonNullable<Parameters<FeatureExtractionPipeline["_call"]>[1]>

export class TransformersJsEmbeddingAdapter<TModel extends string> extends BaseEmbeddingAdapter<
  TModel,
  TransformersJsEmbeddingModelOptions
> {
  readonly name = "transformers-js" as const
  private readonly loadConfig: TransformersJsEmbeddingConfig
  private extractor: Promise<FeatureExtractionPipeline> | undefined
  private ready = false

  constructor(config: TransformersJsEmbeddingConfig, model: TModel) {
    super(model, {})
    this.loadConfig = config
  }

  /** "unavailable" without WebAssembly, "available" once loaded, "downloading" while it loads, else "downloadable". */
  async availability(): Promise<Availability> {
    if (typeof WebAssembly === "undefined") return "unavailable"
    if (!this.extractor) return "downloadable"
    return this.ready ? "available" : "downloading"
  }

  /** Loads the model ahead of the first `embed()`, with its download's progress. Resolves to this adapter. */
  create(options: { onDownloadProgress?: DownloadProgressCallback } = {}): Promise<this> {
    const ready = this.load(options.onDownloadProgress).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Frees the model; the next call loads it again. */
  async destroy(): Promise<void> {
    const extractor = this.extractor
    this.extractor = undefined
    this.ready = false
    await (await extractor?.catch(() => undefined))?.dispose()
  }

  /** The pipeline, created once per adapter (again after a failed load). */
  private load(onDownloadProgress?: DownloadProgressCallback): Promise<FeatureExtractionPipeline> {
    const listeners = [this.loadConfig.onDownloadProgress, onDownloadProgress].filter((listener) => !!listener)
    if (this.extractor) {
      if (listeners.length) void this.extractor.then(() => listeners.forEach((listener) => listener(1)), () => undefined)
      return this.extractor
    }
    const { device, dtype } = this.loadConfig
    const extractor = import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("feature-extraction", this.model, {
          ...(device && { device }),
          ...(dtype && { dtype }),
          progress_callback: (info: ProgressInfo) => {
            if (info.status === "progress_total" && info.total) {
              for (const listener of listeners) listener(Math.min(1, info.loaded / info.total))
            }
          }
        }) as Promise<FeatureExtractionPipeline>
    )
    this.extractor = extractor
    extractor.then(
      () => {
        this.ready = this.extractor === extractor
        for (const listener of listeners) listener(1)
      },
      () => {
        if (this.extractor === extractor) this.extractor = undefined
      }
    )
    return extractor
  }

  async createEmbeddings(options: EmbeddingOptions<TransformersJsEmbeddingModelOptions>): Promise<EmbeddingResult> {
    const { logger, modelOptions } = options
    const model = options.model as TModel
    try {
      const texts = requireTextOnlyEmbeddingInput(options.input, this.name, model)
      if (options.dimensions !== undefined) {
        throw new Error(`Transformers.js models return their own size of vector: leave \`dimensions\` out.`)
      }
      logger.request(`activity=embed provider=${this.name} model=${model} inputs=${texts.length}`, { provider: this.name, model })
      const extractor = await this.load()
      const output = await extractor(texts, { pooling: "mean", normalize: true, ...modelOptions })
      const vectors = output.tolist() as Array<Array<number>>
      return {
        id: this.generateId(this.name),
        model,
        embeddings: vectors.map((vector, index) => ({ vector, index }))
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
 * A TanStack AI embedding adapter for a Transformers.js model (any Hugging
 * Face feature-extraction model with ONNX weights): all-MiniLM-L6-v2 by
 * default, small and quick (30 MB in q4f16; 384 numbers a vector).
 *
 * @example
 * ```ts
 * const { embeddings } = await embed({ adapter: transformersJsEmbedding(), input: ["a red guitar", "a blue drum kit"] })
 * ```
 */
export function transformersJsEmbedding<TModel extends string = "onnx-community/all-MiniLM-L6-v2-ONNX">(
  model: TModel = "onnx-community/all-MiniLM-L6-v2-ONNX" as TModel,
  config: TransformersJsEmbeddingConfig = {}
): TransformersJsEmbeddingAdapter<TModel> {
  return new TransformersJsEmbeddingAdapter(config, model)
}
