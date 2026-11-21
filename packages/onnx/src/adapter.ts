/**
 * TanStack AI's image adapter for ONNX models in the browser, on ONNX
 * Runtime Web: WebGPU where the browser has a GPU adapter, else the CPU
 * (WebAssembly). `generateImage({ adapter: onnxImage(model), prompt })`.
 */
import { Tokenizer } from "@huggingface/tokenizers"
import type {
  ImageGenerationOptions,
  ImageGenerationResult
} from "@tanstack/ai"
import { BaseImageAdapter } from "@tanstack/ai/adapters"
import type { InferenceSession } from "onnxruntime-web"

import { fileUrl, ONNX_MODEL_META } from "./model-meta.js"
import type {
  OnnxImageModel,
  OnnxImageModelMeta,
  OnnxImageModelSizeByName
} from "./model-meta.js"
import { encodePng, toBase64 } from "./png.js"
import {
  createSessions,
  DEFAULT_WASM_PATHS,
  hasWebGpu,
  loadOrt
} from "./runtime.js"
import type { OnnxBackend, Ort } from "./runtime.js"
import { serial } from "./lifecycle.js"
import { allStored, fileBytes, removeFiles } from "./storage.js"
import {
  DEFAULT_SAMPLER,
  drawSprites,
  fixedLengthIds,
  GRID,
  spritePixels
} from "./tessera.js"

/** Download progress, 0 to 1 (1 once the model is loaded). */
export type DownloadProgressCallback = (progress: number) => void

/** Where a model stands on this device. */
export type Availability =
  "unavailable" | "downloadable" | "downloading" | "available"

export type OnnxImageConfig = {
  /** Called with every model download's progress, 0 to 1. */
  onDownloadProgress?: DownloadProgressCallback
  /** Where ONNX Runtime's WebAssembly files load from (default: jsDelivr, at the installed version). */
  wasmPaths?: string
  /** Run on this backend instead of the best one the browser has. */
  backend?: OnnxBackend
  /** ONNX Runtime session options, over the adapter's own (see runtime.ts's `createSessions`). */
  sessionOptions?: InferenceSession.SessionOptions
  /** ONNX Runtime WebGPU backend options (such as `storageBufferCacheMode`), on WebGPU. */
  webgpuOptions?: Record<string, unknown>
}

/** Sampler settings, per call (`modelOptions`). */
export type OnnxImageProviderOptions = {
  /** The random seed: the same seed, prompt and settings draw the same images. Random if left out. */
  seed?: number
  /** Denoiser passes (default 16). Fewer is faster and rougher. */
  steps?: number
  /** Classifier-free guidance (default 3): how strongly the images follow the prompt. */
  guidanceScale?: number
}

/** Most images one call draws (each is two rows of the denoiser's batch). */
export const MAX_IMAGES = 8

type Loaded = {
  model: string
  backend: OnnxBackend
  ort: Ort
  denoiser: InferenceSession
  textEncoder: InferenceSession
  tokenizer: Tokenizer
  /** CLIP's end-of-text token, which also pads the text encoder's input. */
  endToken: number
  palette: ReadonlyArray<ReadonlyArray<number>>
}

/**
 * The page's loaded model: one at a time, so two never sit in memory
 * together. Only tasks in the lifecycle queue (lifecycle.ts) change it.
 */
let current: { key: string; ready: Promise<Loaded> } | undefined

/** A stable id for a value JSON can't stand for (a GPUDevice in webgpuOptions, say), by identity. */
const identities = new WeakMap<object, number>()
let nextIdentity = 0
const settingsKey = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) => {
    const plain =
      typeof v !== "object" ||
      v === null ||
      Array.isArray(v) ||
      Object.getPrototypeOf(v) === Object.prototype
    if (typeof v === "function" || !plain) {
      const object = v as object
      if (!identities.has(object)) identities.set(object, ++nextIdentity)
      return `#${identities.get(object)}`
    }
    return v
  })

async function release(entry: { ready: Promise<Loaded> }) {
  const loaded = await entry.ready.catch(() => undefined)
  if (loaded)
    await Promise.all([loaded.denoiser.release(), loaded.textEncoder.release()])
}

const modelUrls = (meta: OnnxImageModelMeta) =>
  Object.values(meta.files).map((file) => fileUrl(meta, file))

/** The prompt's text: a string, or its text parts. Image-conditioned prompts aren't supported. */
function promptText(prompt: ImageGenerationOptions["prompt"]): string {
  if (typeof prompt === "string") return prompt
  return prompt
    .map((part) => {
      if (part.type !== "text")
        throw new Error(
          `onnxImage only takes text prompts, not ${part.type} parts`
        )
      return part.content
    })
    .join(" ")
}

export class OnnxImageAdapter<
  TModel extends OnnxImageModel
> extends BaseImageAdapter<
  TModel,
  OnnxImageProviderOptions,
  Record<OnnxImageModel, OnnxImageProviderOptions>,
  OnnxImageModelSizeByName
> {
  readonly name = "onnx" as const
  private readonly meta: OnnxImageModelMeta
  private readonly settings: OnnxImageConfig
  /** Downloads of this adapter's model going on now. */
  private downloading = 0

  constructor(model: TModel, config: OnnxImageConfig = {}) {
    super(model, {})
    const meta: OnnxImageModelMeta | undefined = ONNX_MODEL_META[model]
    if (!meta) throw new Error(`onnxImage doesn't know ${model}`)
    this.meta = meta
    this.settings = config
  }

  /** What the page's sessions are made for: the model and every setting that changes them. */
  private get key() {
    const { backend, wasmPaths, sessionOptions, webgpuOptions } = this.settings
    return JSON.stringify([
      this.model,
      backend ?? null,
      wasmPaths ?? null,
      settingsKey(sessionOptions),
      settingsKey(webgpuOptions)
    ])
  }

  /** The backend the model runs on, once it's loaded here. */
  async backend(): Promise<OnnxBackend | undefined> {
    if (current?.key !== this.key) return undefined
    return (await current.ready.catch(() => undefined))?.backend
  }

  /**
   * Where the model stands here: "unavailable" without WebAssembly;
   * "available" once its files are stored (or it's loaded); "downloading"
   * while this adapter downloads it; else "downloadable" (it downloads at
   * `create`, or at the first `generateImage()`).
   */
  async availability(): Promise<Availability> {
    if (typeof WebAssembly === "undefined") return "unavailable"
    if (current?.key === this.key) return "available"
    if (this.downloading > 0) return "downloading"
    return (await allStored(modelUrls(this.meta)))
      ? "available"
      : "downloadable"
  }

  /**
   * Downloads the model if it isn't stored and loads it, with the download's
   * progress, 0 to 1, then 1 once it's ready. Resolves to this adapter.
   * `generateImage()` doesn't need it: the first call loads the model too.
   * Loading another model first unloads the page's current one.
   */
  create(
    options: {
      onDownloadProgress?: DownloadProgressCallback
      signal?: AbortSignal
    } = {}
  ): Promise<this> {
    const ready = serial(() => this.load(options), options.signal).then(() => {
      options.onDownloadProgress?.(1)
      this.settings.onDownloadProgress?.(1)
      return this
    })
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, if it's the page's, after the drawings queued before. Its stored files stay. */
  destroy(): Promise<void> {
    return serial(() => this.unloadNow())
  }

  /** Removes the model's stored files, after unloading it. Returns whether any were stored. */
  remove(): Promise<boolean> {
    return serial(async () => {
      await this.unloadNow()
      return removeFiles(modelUrls(this.meta))
    })
  }

  /** (In the lifecycle queue.) */
  private async unloadNow() {
    if (current?.key !== this.key) return
    const entry = current
    current = undefined
    await release(entry)
  }

  /**
   * (In the lifecycle queue.) The page's sessions for this adapter's model
   * and settings: the ones loaded, or new ones after the page's others are
   * released.
   */
  private async load(
    options: {
      onDownloadProgress?: DownloadProgressCallback
      signal?: AbortSignal
    } = {}
  ): Promise<Loaded> {
    if (current?.key === this.key) return current.ready
    if (current) {
      const previous = current
      current = undefined
      await release(previous)
    }
    const ready = this.loadFresh(options)
    const entry = { key: this.key, ready }
    current = entry
    ready.catch(() => {
      if (current === entry) current = undefined
    })
    return ready
  }

  private async loadFresh(options: {
    onDownloadProgress?: DownloadProgressCallback
    signal?: AbortSignal
  }): Promise<Loaded> {
    const { meta } = this
    const { files } = meta
    const stored = await allStored(modelUrls(meta))
    const total = files.denoiser.bytes + files.textEncoder.bytes
    const seen = { denoiser: 0, textEncoder: 0 }
    const report = () => {
      const progress = Math.min(
        (seen.denoiser + seen.textEncoder) / total,
        0.999
      )
      options.onDownloadProgress?.(progress)
      this.settings.onDownloadProgress?.(progress)
    }
    const signal = options.signal
    signal?.throwIfAborted()
    if (!stored) this.downloading++
    let bytes: [ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer]
    try {
      bytes = await Promise.all([
        fileBytes(fileUrl(meta, files.denoiser), {
          signal,
          onBytes: (n) => ((seen.denoiser = n), report())
        }),
        fileBytes(fileUrl(meta, files.textEncoder), {
          signal,
          onBytes: (n) => ((seen.textEncoder = n), report())
        }),
        fileBytes(fileUrl(meta, files.tokenizer), { signal }),
        fileBytes(fileUrl(meta, files.palette), { signal })
      ])
    } finally {
      if (!stored) this.downloading--
    }
    const [denoiserBytes, textEncoderBytes, tokenizerBytes, paletteBytes] =
      bytes
    const decode = (b: ArrayBuffer) =>
      JSON.parse(new TextDecoder().decode(b)) as unknown
    const tokenizer = new Tokenizer(decode(tokenizerBytes) as object, {})
    const palette = (
      decode(paletteBytes) as { palette_rgba: Array<Array<number>> }
    ).palette_rgba
    const endToken = tokenizer.token_to_id("<|endoftext|>")
    if (endToken === undefined)
      throw new Error(`${this.model}'s tokenizer has no <|endoftext|> token`)

    const ort = await loadOrt(this.settings.wasmPaths ?? DEFAULT_WASM_PATHS)
    // Cached files come back whatever the signal says: a caller that stopped meanwhile makes no sessions.
    signal?.throwIfAborted()
    const files_ = { denoiser: denoiserBytes, textEncoder: textEncoderBytes }
    let backend: OnnxBackend =
      this.settings.backend ?? ((await hasWebGpu()) ? "webgpu" : "wasm")
    let sessions: Record<"denoiser" | "textEncoder", InferenceSession>
    const extra = this.settings.sessionOptions
    try {
      sessions = await createSessions(
        ort,
        files_,
        backend,
        extra,
        this.settings.webgpuOptions
      )
    } catch (error) {
      // A GPU that can't take the model: the CPU still can (unless asked for WebGPU).
      if (backend !== "webgpu" || this.settings.backend) throw error
      console.warn(
        "onnxImage: WebGPU couldn't load the model, running it on the CPU",
        error
      )
      backend = "wasm"
      sessions = await createSessions(
        ort,
        files_,
        backend,
        extra,
        this.settings.webgpuOptions
      )
    }
    return {
      model: this.model,
      backend,
      ort,
      ...sessions,
      tokenizer,
      endToken,
      palette
    }
  }

  async generateImages(
    options: ImageGenerationOptions<
      OnnxImageProviderOptions,
      OnnxImageModelSizeByName[TModel]
    >
  ): Promise<ImageGenerationResult> {
    const { logger, abortSignal, modelOptions = {} } = options
    const count = options.numberOfImages ?? 1
    try {
      if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) {
        throw new Error(
          `numberOfImages must be 1 to ${MAX_IMAGES}, not ${count}`
        )
      }
      if (options.size !== undefined && options.size !== this.meta.size) {
        throw new Error(
          `${this.model} draws ${this.meta.size} images, not ${options.size}`
        )
      }
      const text = promptText(options.prompt).trim()
      if (!text) throw new Error("The prompt is empty")
      const sampler = samplerSettings(modelOptions)
      logger.request(`onnx.generateImages ${this.model}`, {
        provider: "onnx",
        model: this.model,
        numberOfImages: count
      })
      // Loading (or switching) and drawing in one task: nothing else releases these sessions meanwhile.
      const images = await serial(async () => {
        const loaded = await this.load(
          abortSignal ? { signal: abortSignal } : {}
        )
        const ids = fixedLengthIds(
          loaded.tokenizer.encode(text).ids,
          loaded.endToken
        )
        const sprites = await drawSprites(
          {
            Tensor: loaded.ort.Tensor,
            denoiser: loaded.denoiser,
            textEncoder: loaded.textEncoder
          },
          ids,
          count,
          sampler,
          abortSignal
        )
        return Promise.all(
          sprites.map(async (tokens) =>
            toBase64(
              await encodePng(spritePixels(tokens, loaded.palette), GRID, GRID)
            )
          )
        )
      }, abortSignal)
      return {
        id: this.generateId(),
        model: this.model,
        images: images.map((b64Json) => ({ b64Json }))
      }
    } catch (error) {
      logger.errors(`onnx.generateImages ${this.model} failed`, {
        error,
        source: "onnx.generateImages"
      })
      throw error
    }
  }
}

/** Most denoising steps one call takes. */
export const MAX_STEPS = 1000

/** The sampler's settings for a call: the defaults, with `modelOptions`' own after checking them. */
function samplerSettings(options: OnnxImageProviderOptions) {
  const { seed, steps, guidanceScale } = options
  if (
    steps !== undefined &&
    (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS)
  ) {
    throw new Error(
      `steps must be a whole number from 1 to ${MAX_STEPS}, not ${steps}`
    )
  }
  if (guidanceScale !== undefined && !Number.isFinite(guidanceScale)) {
    throw new Error(
      `guidanceScale must be a finite number, not ${guidanceScale}`
    )
  }
  if (seed !== undefined && !Number.isFinite(seed))
    throw new Error(`seed must be a finite number, not ${seed}`)
  return {
    ...DEFAULT_SAMPLER,
    ...(steps !== undefined && { steps }),
    ...(guidanceScale !== undefined && { guidanceScale }),
    seed: seed ?? Math.floor(Math.random() * 2 ** 32)
  }
}

/** An image adapter for one of the catalog's ONNX models. */
export function onnxImage<TModel extends OnnxImageModel>(
  model: TModel,
  config: OnnxImageConfig = {}
): OnnxImageAdapter<TModel> {
  return new OnnxImageAdapter(model, config)
}
