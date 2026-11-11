/**
 * A TanStack AI embedding adapter for Transformers.js, shaped like TanStack's
 * own (`@tanstack/ai-openai`'s `openaiEmbedding`):
 * `embed({ adapter: transformersJsEmbedding(), input })`. It loads
 * Transformers.js's own `feature-extraction` pipeline on the page, as
 * browser-ai does, and runs the pipeline's steps (its tokenizer, its model,
 * Transformers.js's pooling) with the tokenizer cut at the adapter's
 * `maxTokens`, counting the tokens read. Transformers.js is imported the
 * first time it's used.
 */
import { requireTextOnlyEmbeddingInput } from "@tanstack/ai"
import type { EmbeddingOptions, EmbeddingResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseEmbeddingAdapter } from "@tanstack/ai/adapters"
import type { FeatureExtractionPipeline, ProgressInfo, Tensor } from "@huggingface/transformers"

import type { Availability, DownloadProgressCallback } from "./client.js"
import type { Device, Dtype } from "./protocol.js"

export type TransformersJsEmbeddingConfig = {
  /** "webgpu" or "wasm" (the CPU): Transformers.js's default otherwise. */
  device?: Device
  /** The ONNX weights to load: Transformers.js's default otherwise. */
  dtype?: Dtype
  /**
   * Most tokens read of each text; the rest is cut off. The model's own
   * limit by default (its tokenizer's `model_max_length`, 512 for most),
   * and never more than it.
   */
  maxTokens?: number
  /** The model's download progress, 0 to 1, then 1 once it's ready. */
  onDownloadProgress?: DownloadProgressCallback
}

type PipelineOptions = NonNullable<Parameters<FeatureExtractionPipeline["_call"]>[1]>

/**
 * Per-call `modelOptions`: the pipeline's own options (`pooling`,
 * `normalize`, `quantize`, `precision`), applied as the pipeline does. Mean pooling and
 * normalized vectors by default, as sentence-transformers models expect.
 * A pooling is needed: `"none"` gives a vector a token, not one a text.
 */
export type TransformersJsEmbeddingModelOptions = Omit<PipelineOptions, "pooling"> & {
  pooling?: Exclude<PipelineOptions["pooling"], "none">
}

/** The pipeline, and Transformers.js's own pooling and quantizing, which the pipeline uses. */
type Loaded = {
  extractor: FeatureExtractionPipeline
  mean_pooling: (hidden: Tensor, attentionMask: Tensor) => Tensor
  quantize_embeddings: (tensor: Tensor, precision: "binary" | "ubinary") => Tensor
}

/** The tokens the model read: the attention mask's ones. */
const tokensIn = (attentionMask: Tensor) =>
  Array.from(attentionMask.data as ArrayLike<number | bigint>, Number).reduce((sum, bit) => sum + bit, 0)

export class TransformersJsEmbeddingAdapter<TModel extends string> extends BaseEmbeddingAdapter<
  TModel,
  TransformersJsEmbeddingModelOptions
> {
  readonly name = "transformers-js" as const
  private readonly loadConfig: TransformersJsEmbeddingConfig
  private extractor: Promise<Loaded> | undefined
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
    await (await extractor?.catch(() => undefined))?.extractor.dispose()
  }

  /** The pipeline, created once per adapter (again after a failed load). */
  private load(onDownloadProgress?: DownloadProgressCallback): Promise<Loaded> {
    const listeners = [this.loadConfig.onDownloadProgress, onDownloadProgress].filter((listener) => !!listener)
    if (this.extractor) {
      if (listeners.length) void this.extractor.then(() => listeners.forEach((listener) => listener(1)), () => undefined)
      return this.extractor
    }
    const { device, dtype } = this.loadConfig
    const extractor = import("@huggingface/transformers").then(async ({ pipeline, mean_pooling, quantize_embeddings }) => ({
      extractor: (await pipeline("feature-extraction", this.model, {
        ...(device && { device }),
        ...(dtype && { dtype }),
        progress_callback: (info: ProgressInfo) => {
          if (info.status === "progress_total" && info.total) {
            for (const listener of listeners) listener(Math.min(1, info.loaded / info.total))
          }
        }
      })) as FeatureExtractionPipeline,
      mean_pooling,
      quantize_embeddings
    }))
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
      const { extractor, mean_pooling, quantize_embeddings } = await this.load()
      const { pooling = "mean", normalize = true, quantize = false, precision = "binary" } = modelOptions ?? {}
      const { maxTokens } = this.loadConfig
      // The pipeline's own steps, with the tokenizer's limit.
      const inputs = extractor.tokenizer(texts, { padding: true, truncation: true, ...(maxTokens !== undefined && { max_length: maxTokens }) }) as {
        attention_mask: Tensor
      }
      const outputs = (await extractor.model(inputs)) as Record<string, Tensor | undefined>
      let output = (outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings) as Tensor
      const pool: string = pooling
      if (pool === "mean") output = mean_pooling(output, inputs.attention_mask)
      else if (pool === "first_token" || pool === "cls") output = output.slice(null, 0)
      else if (pool === "last_token" || pool === "eos") output = output.slice(null, -1)
      else if (pool !== "none") throw new Error(`Pooling method '${pool}' not supported.`)
      if (normalize) output = output.normalize(2, -1)
      if (quantize) output = quantize_embeddings(output, precision)
      // One vector a text: [texts, size]. Unpooled output has a vector a token.
      if (output.dims.length !== 2 || output.dims[0] !== texts.length) {
        throw new Error(
          `Transformers.js returned output of shape [${output.dims.join(", ")}], not one vector a text: set a \`pooling\` other than "none".`
        )
      }
      const vectors = output.tolist() as Array<Array<number>>
      const promptTokens = tokensIn(inputs.attention_mask)
      return {
        id: this.generateId(this.name),
        model,
        embeddings: vectors.map((vector, index) => ({ vector, index })),
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens }
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
