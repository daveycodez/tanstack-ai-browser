/**
 * A TanStack AI image adapter for webgllm: Tessera-small (16×16 pixel-art
 * sprites from text) on webgllm's own engines, WebGPU where the browser has
 * it and the GPU passes the model's self-test, else WebGL 2, in a Web
 * Worker. `generateImage({ adapter: webgllmImage(model), prompt })`.
 * It runs in the same `WebGLLM` as the text adapter (the page's, or the
 * one for the adapter's own `worker`), so text and image models share
 * webgllm's memory budget.
 */
import type {
  ImageGenerationOptions,
  ImageGenerationResult
} from "@tanstack/ai"
import { BaseImageAdapter } from "@tanstack/ai/adapters"
import { IMAGE_MODEL_META, WEBGL_IMAGE_MODELS } from "webgllm"
import type { ImageGenerateParams, LoadProgress } from "webgllm"

import { downloadShare, engineFor, engineRuns } from "./adapter.js"
import type {
  Availability,
  DownloadProgressCallback,
  WebGllmBackend
} from "./adapter.js"

/** The image models webgllm runs, by their Hugging Face repository. */
export const WEBGLLM_IMAGE_MODELS = WEBGL_IMAGE_MODELS

/** An image model webgllm runs. */
export type WebGllmImageModel = (typeof WEBGLLM_IMAGE_MODELS)[number]

/** Each image model's files and license, as webgllm states them. */
export const WEBGLLM_IMAGE_MODEL_META = IMAGE_MODEL_META

/**
 * The PNG sizes each model draws, for TanStack AI's `size`: its own (16x16),
 * or a whole multiple of it (each pixel repeated), such as "128x128".
 */
export type WebGllmImageModelSizeByName = {
  [K in WebGllmImageModel]: `${number}x${number}`
}

/** Sampler settings, per call (`modelOptions`): webgllm's own `images.generate` fields. */
export type WebGllmImageProviderOptions = Pick<
  ImageGenerateParams,
  "seed" | "steps" | "guidance_scale"
>

export type WebGllmImageConfig = {
  /** Called with every model download's progress, 0 to 1. */
  onDownloadProgress?: DownloadProgressCallback
  /** Run in this worker (one running webgllm's `WebGLLMWorkerHandler`) instead of webgllm's own. */
  worker?: Worker
  /** "auto" (the default): WebGPU where it runs the model, else WebGL 2. false: WebGL 2. */
  webgpu?: WebGllmBackend
}

/** The prompt's text: a string, or its text parts. Image-conditioned prompts aren't supported. */
function promptText(prompt: ImageGenerationOptions["prompt"]): string {
  if (typeof prompt === "string") return prompt
  return prompt
    .map((part) => {
      if (part.type !== "text")
        throw new Error(
          `webgllmImage only takes text prompts, not ${part.type} parts`
        )
      return part.content
    })
    .join(" ")
}

export class WebGllmImageAdapter<
  TModel extends WebGllmImageModel
> extends BaseImageAdapter<
  TModel,
  WebGllmImageProviderOptions,
  Record<WebGllmImageModel, WebGllmImageProviderOptions>,
  WebGllmImageModelSizeByName
> {
  readonly name = "webgllm" as const
  private readonly settings: WebGllmImageConfig
  private readonly engine: ReturnType<typeof engineFor>
  /** Loads of this adapter's model going on now. */
  private loading = 0

  constructor(model: TModel, config: WebGllmImageConfig = {}) {
    super(model, {})
    if (!(WEBGLLM_IMAGE_MODELS as ReadonlyArray<string>).includes(model))
      throw new Error(`webgllmImage doesn't know ${model}`)
    this.settings = config
    this.engine = engineFor(config.worker, config.webgpu)
  }

  private get images() {
    return this.engine.webgllm.images
  }

  /** The GPU API the model runs on, once it's loaded here. */
  engineInUse(): "webgpu" | "webgl" | null {
    return this.images.engineOf(this.model)
  }

  /**
   * Where the model stands here: "unavailable" where webgllm's engine can't
   * run; "available" once it's loaded; "downloading" while this adapter
   * loads it; else "downloadable" (it loads, downloading what isn't stored,
   * at `create` or the first `generateImage()`).
   */
  async availability(): Promise<Availability> {
    if (!engineRuns()) return "unavailable"
    if (this.images.isLoaded(this.model)) return "available"
    return this.loading > 0 ? "downloading" : "downloadable"
  }

  /** Loads the model (downloading what isn't stored), with the download's progress, 0 to 1, then 1. Resolves to this adapter. */
  create(
    options: {
      onDownloadProgress?: DownloadProgressCallback
      signal?: AbortSignal
    } = {}
  ): Promise<this> {
    const ready = this.load(options.signal, options.onDownloadProgress).then(
      () => this
    )
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, freeing its memory at once. Its files stay. Never rejects. */
  destroy(): Promise<void> {
    return this.images.unload(this.model).catch(() => undefined)
  }

  private async load(
    signal: AbortSignal | undefined,
    onDownloadProgress?: DownloadProgressCallback
  ) {
    this.loading++
    try {
      await this.images.load(this.model, {
        ...(signal && { signal }),
        onProgress: this.progress(onDownloadProgress)
      })
    } finally {
      this.loading--
    }
    onDownloadProgress?.(1)
    this.settings.onDownloadProgress?.(1)
  }

  /** webgllm's load progress, as the download's share (0 to 1) for this call's callback and the config's. */
  private progress(onDownloadProgress?: DownloadProgressCallback) {
    return (progress: LoadProgress) => {
      if (progress.phase !== "download" || progress.cached) return
      const share = downloadShare(progress)
      onDownloadProgress?.(share)
      this.settings.onDownloadProgress?.(share)
    }
  }

  async generateImages(
    options: ImageGenerationOptions<
      WebGllmImageProviderOptions,
      WebGllmImageModelSizeByName[TModel]
    >
  ): Promise<ImageGenerationResult> {
    const { logger, abortSignal, modelOptions = {} } = options
    try {
      const prompt = promptText(options.prompt).trim()
      if (!prompt) throw new Error("The prompt is empty")
      logger.request(`webgllm.images.generate ${this.model}`, {
        provider: "webgllm",
        model: this.model,
        numberOfImages: options.numberOfImages ?? 1
      })
      // webgllm checks the request before it loads the model (an invalid one downloads nothing), and loads it when it isn't.
      const loading = !this.images.isLoaded(this.model)
      if (loading) this.loading++
      let response: Awaited<ReturnType<typeof this.images.generate>>
      try {
        response = await this.images.generate(
          {
            model: this.model,
            prompt,
            n: options.numberOfImages ?? 1,
            response_format: "b64_json",
            ...(options.size && { size: options.size }),
            ...(modelOptions.seed !== undefined && { seed: modelOptions.seed }),
            ...(modelOptions.steps !== undefined && {
              steps: modelOptions.steps
            }),
            ...(modelOptions.guidance_scale !== undefined && {
              guidance_scale: modelOptions.guidance_scale
            })
          },
          {
            ...(abortSignal && { signal: abortSignal }),
            onProgress: this.progress()
          }
        )
      } finally {
        if (loading) this.loading--
      }
      if (loading) this.settings.onDownloadProgress?.(1)
      return {
        id: this.generateId(),
        model: this.model,
        images: response.data.flatMap((image) =>
          image.b64_json ? [{ b64Json: image.b64_json }] : []
        )
      }
    } catch (error) {
      logger.errors(`webgllm.images.generate ${this.model} failed`, {
        error,
        source: "webgllm.images.generate"
      })
      throw error
    }
  }
}

/** An image adapter for one of webgllm's image models. */
export function webgllmImage<TModel extends WebGllmImageModel>(
  model: TModel,
  config: WebGllmImageConfig = {}
): WebGllmImageAdapter<TModel> {
  return new WebGllmImageAdapter(model, config)
}
