/**
 * The embedding adapter, shaped like TanStack AI's own (`@tanstack/ai-openai`'s
 * and `@tanstack/ai-gemini`'s): `embed({ adapter: mediaPipeEmbedding(), input })`.
 */
import { FilesetResolver, TextEmbedder } from "@mediapipe/tasks-text"
import { requireTextOnlyEmbeddingInput } from "@tanstack/ai"
import type { EmbeddingOptions, EmbeddingResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseEmbeddingAdapter } from "@tanstack/ai/adapters"

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
import { toVector } from "./vectors.js"
import { MEDIAPIPE_WASM_URL } from "./version.js"

export type { MediaPipeEmbeddingConfig, MediaPipeEmbeddingProviderOptions }

/** Where the model stands, with the Prompt API's values (`LanguageModel.availability()`). */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/**
 * MediaPipe embedding adapter: text embeddings from Google's MediaPipe
 * TextEmbedder, in the browser, on the page.
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
  private embedder: Promise<TextEmbedder> | undefined
  private ready = false
  /** Calls run one at a time, so one call's `setOptions` never lands in another's batch. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(config: MediaPipeEmbeddingConfig, model: TModel) {
    super(model, {})
    this.loadConfig = config
  }

  /**
   * Where the model stands for this adapter: "unavailable" without
   * WebAssembly, "available" once its embedder is loaded, "downloading"
   * while it loads, else "downloadable" (MediaPipe's files may already be in
   * the browser's HTTP cache, which a page can't see).
   */
  async availability(): Promise<Availability> {
    if (typeof WebAssembly === "undefined") return "unavailable"
    if (!this.embedder) return "downloadable"
    return this.ready ? "available" : "downloading"
  }

  /**
   * Creates the embedder ahead of the first `embed()` (which creates it
   * otherwise). Resolves to this adapter; rejects if MediaPipe can't load
   * (fine to leave unawaited).
   */
  create(): Promise<this> {
    const ready = this.load().then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Closes the embedder, freeing it; the next call creates it again. */
  async destroy(): Promise<void> {
    const embedder = this.embedder
    this.embedder = undefined
    this.ready = false
    ;(await embedder?.catch(() => undefined))?.close()
  }

  /** MediaPipe's TextEmbedder, created once per adapter (again after a failed load). */
  private load(): Promise<TextEmbedder> {
    if (this.embedder) return this.embedder
    const { delegate, modelAssetPath, wasmPath } = this.loadConfig
    const embedder = FilesetResolver.forTextTasks(wasmPath ?? MEDIAPIPE_WASM_URL).then((fileset) =>
      TextEmbedder.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelAssetPath ?? MEDIAPIPE_MODEL_META[this.model].file,
          ...(delegate && { delegate })
        }
      })
    )
    this.embedder = embedder
    embedder.then(
      () => (this.ready = this.embedder === embedder),
      () => {
        if (this.embedder === embedder) this.embedder = undefined
      }
    )
    return embedder
  }

  async createEmbeddings(
    options: EmbeddingOptions<MediaPipeEmbeddingProviderOptions>
  ): Promise<EmbeddingResult> {
    const { logger, modelOptions } = options
    const model = options.model as TModel
    try {
      const texts = requireTextOnlyEmbeddingInput(options.input, this.name, model)
      const fixed = MEDIAPIPE_MODEL_META[model].dimensions
      // A custom model file's size isn't known.
      if (options.dimensions !== undefined && !this.loadConfig.modelAssetPath && options.dimensions !== fixed) {
        throw new Error(
          `MediaPipe model "${model}" returns ${fixed} dimensions and can't return ${options.dimensions}: leave \`dimensions\` out, or set it to ${fixed}.`
        )
      }
      logger.request(
        `activity=embed provider=${this.name} model=${model} inputs=${texts.length}`,
        { provider: this.name, model }
      )
      const run = this.queue.then(async () => {
        const embedder = await this.load()
        await embedder.setOptions({
          l2Normalize: modelOptions?.l2Normalize ?? false,
          quantize: modelOptions?.quantize ?? false
        })
        return texts.map((text) => toVector(embedder.embed(text).embeddings[0]))
      })
      this.queue = run.catch(() => undefined)
      const vectors = await run
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
