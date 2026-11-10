/**
 * A TanStack AI transcription adapter for Whisper on Transformers.js, shaped
 * like TanStack's own (`@tanstack/ai-openai`'s `openaiTranscription`):
 * `generateTranscription({ adapter: transformersJsTranscription(), audio })`.
 * It runs Transformers.js's own `automatic-speech-recognition` pipeline
 * (transcription-handler.ts) on the page, as browser-ai runs Whisper, or in
 * a Web Worker of your own; Transformers.js is imported the first time it's
 * used. The page decodes the audio either way: workers have no Web Audio.
 */
import type { TranscriptionOptions, TranscriptionResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseTranscriptionAdapter } from "@tanstack/ai/adapters"
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"

import type { Availability, DownloadProgressCallback } from "./client.js"
import { givenWorker, inProcess } from "./port.js"
import type { Open, Port } from "./port.js"
import type { Device, Dtype, TranscriptionLoadSettings, TranscriptionReply, TranscriptionRequest } from "./protocol.js"

export type TransformersJsTranscriptionConfig = {
  /** "webgpu" or "wasm" (the CPU): Transformers.js's default otherwise. */
  device?: Device
  /** The ONNX weights to load: Transformers.js's default otherwise. */
  dtype?: Dtype
  /**
   * A Web Worker of your own to run Whisper in, off the page's main thread:
   * a module whose `onmessage` goes to a
   * `TransformersJsTranscriptionWorkerHandler`
   * (exported from this package). It holds one model,
   * so adapters given the same worker share it; `destroy()` frees the model
   * and leaves the worker running. Left out, Whisper runs on the page.
   */
  worker?: Worker
  /** The model's download progress, 0 to 1, then 1 once it's ready. */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Per-call `modelOptions`: the pipeline's own options (`task`,
 * `chunk_length_s`, `stride_length_s`, `return_timestamps`, …), sent as
 * given. Audio is read in 30-second chunks by default, so long recordings
 * work.
 */
export type TransformersJsTranscriptionModelOptions = NonNullable<Parameters<AutomaticSpeechRecognitionPipeline["_call"]>[1]>

type Transcript = Extract<TranscriptionReply, { status: "result" }>

/**
 * Whisper's handler and the model it holds. Requests take turns: a
 * transcription holds the handler from loading its model to its result.
 */
function createTranscriber(open: Open<TranscriptionRequest, TranscriptionReply>) {
  let port: Port<TranscriptionRequest> | null = null
  let listener: ((reply: TranscriptionReply) => void) | null = null
  /** The settings of the model the handler holds, and of one it's loading. */
  let loaded: string | null = null
  let loading: string | null = null
  let tail: Promise<unknown> = Promise.resolve()

  /** Waits for the handler's turn; call the release it resolves to when done. */
  function turn(): Promise<() => void> {
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => (release = resolve))
    const ready = tail.then(() => release)
    tail = tail.then(() => held)
    return ready
  }

  /** One request, and the reply `settle` takes as its end. */
  function ask<T>(
    request: TranscriptionRequest,
    settle: (reply: TranscriptionReply) => T | undefined,
    transfer?: Array<Transferable>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      listener = (reply) => {
        if (reply.status === "error") return reject(new Error(reply.message))
        const value = settle(reply)
        if (value !== undefined) resolve(value)
      }
      port ??= open(
        (reply) => listener?.(reply),
        (message) => listener?.({ status: "error", message })
      )
      port.post(request, transfer)
    }).finally(() => {
      listener = null
    })
  }

  /** The model, loaded in the handler unless it's the one there; call it within a turn. */
  async function ensure(settings: TranscriptionLoadSettings, listeners: Array<DownloadProgressCallback>) {
    const key = JSON.stringify(settings)
    if (loaded !== key) {
      loaded = null
      loading = key
      try {
        await ask({ type: "load", settings }, (reply) => {
          if (reply.status === "progress") for (const report of listeners) report(reply.progress)
          return reply.status === "ready" ? true : undefined
        })
        loaded = key
      } finally {
        loading = null
      }
    }
    for (const report of listeners) report(1)
  }

  return {
    /** Loads the model ahead of a transcription, with its download's progress, then 1. */
    async load(settings: TranscriptionLoadSettings, listeners: Array<DownloadProgressCallback>) {
      const release = await turn()
      try {
        await ensure(settings, listeners)
      } finally {
        release()
      }
    },

    /** The transcript of `samples` (16 kHz), on the model `settings` names, loading it first if it isn't there. */
    async transcribe(
      settings: TranscriptionLoadSettings,
      listeners: Array<DownloadProgressCallback>,
      samples: Float32Array,
      options: Record<string, unknown>
    ): Promise<Transcript> {
      const release = await turn()
      try {
        await ensure(settings, listeners)
        // A worker takes the samples' buffer; a handler on the page reads them in place.
        return await ask(
          { type: "transcribe", samples, options },
          (reply) => (reply.status === "result" ? reply : undefined),
          [samples.buffer]
        )
      } finally {
        release()
      }
    },

    /** Frees the model, if `model` is the one the handler holds, after the requests before it. */
    async unload(model: string) {
      const release = await turn()
      try {
        if (!loaded || (JSON.parse(loaded) as TranscriptionLoadSettings).model !== model) return
        loaded = null
        await ask({ type: "unload" }, (reply) => (reply.status === "unloaded" ? true : undefined))
      } finally {
        release()
      }
    },

    /** Whether the handler holds `model`, or is loading it. */
    state(model: string): "loaded" | "loading" | "none" {
      const holds = (key: string | null) => !!key && (JSON.parse(key) as TranscriptionLoadSettings).model === model
      return holds(loaded) ? "loaded" : holds(loading) ? "loading" : "none"
    }
  }
}

type Transcriber = ReturnType<typeof createTranscriber>

/** Whisper's handler on the page. */
const onPage = inProcess<TranscriptionRequest, TranscriptionReply, { onmessage(event: { data: TranscriptionRequest }): void }>(
  (onReply) =>
    import("./transcription-handler.js").then(
      ({ TransformersJsTranscriptionWorkerHandler }) => new TransformersJsTranscriptionWorkerHandler(onReply)
    ),
  (handler, request) => handler.onmessage({ data: request })
)

/** The callers' own workers' handlers: one a worker. */
const given = new WeakMap<Worker, Transcriber>()

/** An adapter's handler: its own worker's (shared by every adapter given that worker), else one of its own on the page. */
function transcriberFor(worker?: Worker): Transcriber {
  if (!worker) return createTranscriber(onPage)
  let transcriber = given.get(worker)
  if (!transcriber) given.set(worker, (transcriber = createTranscriber(givenWorker<TranscriptionRequest, TranscriptionReply>(worker))))
  return transcriber
}

/** Whisper reads audio at 16 kHz. */
const SAMPLE_RATE = 16_000

/** The audio as a URL Transformers.js's `read_audio` can fetch, and how to let it go. */
function audioUrl(audio: TranscriptionOptions["audio"]): { url: string; release: () => void } {
  if (typeof audio === "string") {
    // A data or http URL as given; else base64.
    return { url: /^(data:|https?:|blob:)/.test(audio) ? audio : `data:audio/wav;base64,${audio}`, release: () => undefined }
  }
  const url = URL.createObjectURL(audio instanceof Blob ? audio : new Blob([audio]))
  return { url, release: () => URL.revokeObjectURL(url) }
}

export class TransformersJsTranscriptionAdapter<TModel extends string> extends BaseTranscriptionAdapter<
  TModel,
  TransformersJsTranscriptionModelOptions
> {
  readonly name = "transformers-js" as const
  private readonly settings: TranscriptionLoadSettings
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  /** Whisper's handler: on the page, or in the adapter's own worker. */
  private readonly transcriber: Transcriber

  constructor(config: TransformersJsTranscriptionConfig, model: TModel) {
    super(model, {})
    this.settings = { model, ...(config.device && { device: config.device }), ...(config.dtype && { dtype: config.dtype }) }
    this.onDownloadProgress = config.onDownloadProgress
    this.transcriber = transcriberFor(config.worker)
  }

  /** "unavailable" without WebAssembly or Web Audio, "available" once loaded, "downloading" while it loads, else "downloadable". */
  async availability(): Promise<Availability> {
    if (typeof WebAssembly === "undefined" || typeof AudioContext === "undefined") return "unavailable"
    const state = this.transcriber.state(this.model)
    return state === "loaded" ? "available" : state === "loading" ? "downloading" : "downloadable"
  }

  /** Loads the model ahead of the first transcription, with its download's progress. Resolves to this adapter. */
  create(options: { onDownloadProgress?: DownloadProgressCallback } = {}): Promise<this> {
    const ready = this.transcriber.load(this.settings, this.listeners(options.onDownloadProgress)).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Frees the model; the next call loads it again. A worker of your own stays running. */
  destroy(): Promise<void> {
    return this.transcriber.unload(this.model)
  }

  private listeners(onDownloadProgress?: DownloadProgressCallback) {
    return [this.onDownloadProgress, onDownloadProgress].filter((listener) => !!listener)
  }

  async transcribe(options: TranscriptionOptions<TransformersJsTranscriptionModelOptions>): Promise<TranscriptionResult> {
    const { logger, modelOptions, language, responseFormat } = options
    const model = options.model as TModel
    try {
      if (options.prompt !== undefined) throw new Error("Transformers.js's Whisper pipeline takes no prompt: leave `prompt` out.")
      logger.request(`activity=transcription provider=${this.name} model=${model}`, { provider: this.name, model })
      const { read_audio } = await import("@huggingface/transformers")
      const { url, release } = audioUrl(options.audio)
      let samples: Float32Array
      try {
        samples = await read_audio(url, SAMPLE_RATE)
      } finally {
        release()
      }
      options.abortSignal?.throwIfAborted()
      const timestamps = responseFormat === "verbose_json"
      // (Before the samples go: a worker takes their buffer.)
      const duration = samples.length / SAMPLE_RATE
      const output = await this.transcriber.transcribe(this.settings, this.listeners(), samples, {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(language && { language }),
        ...(timestamps && { return_timestamps: true }),
        ...modelOptions
      })
      return {
        id: this.generateId(),
        model,
        text: output.text.trim(),
        duration,
        ...(language && { language }),
        ...(output.chunks && {
          segments: output.chunks.map((chunk, id) => ({
            id,
            start: chunk.timestamp[0],
            end: chunk.timestamp[1] ?? duration,
            text: chunk.text.trim()
          }))
        })
      }
    } catch (error) {
      logger.errors(`${this.name}.transcribe fatal`, {
        error: toRunErrorPayload(error, `${this.name}.transcribe failed`),
        source: `${this.name}.transcribe`
      })
      throw error
    }
  }
}

/**
 * A TanStack AI transcription adapter for a Whisper model on Transformers.js
 * (any Hugging Face Whisper model with ONNX weights): Whisper Base by
 * default, as browser-ai uses. `onnx-community/whisper-tiny` is smaller and
 * quicker; `onnx-community/whisper-small` more accurate.
 *
 * @example
 * ```ts
 * const { text } = await generateTranscription({ adapter: transformersJsTranscription(), audio: recording })
 * ```
 */
export function transformersJsTranscription<TModel extends string = "onnx-community/whisper-base">(
  model: TModel = "onnx-community/whisper-base" as TModel,
  config: TransformersJsTranscriptionConfig = {}
): TransformersJsTranscriptionAdapter<TModel> {
  return new TransformersJsTranscriptionAdapter(config, model)
}
