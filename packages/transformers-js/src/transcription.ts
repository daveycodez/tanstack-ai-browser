/**
 * A TanStack AI transcription adapter for Whisper on Transformers.js, shaped
 * like TanStack's own (`@tanstack/ai-openai`'s `openaiTranscription`):
 * `generateTranscription({ adapter: transformersJsTranscription(), audio })`.
 * It runs Transformers.js's own `automatic-speech-recognition` pipeline on
 * the page, as browser-ai runs Whisper; Transformers.js is imported the
 * first time it's used.
 */
import type { TranscriptionOptions, TranscriptionResult } from "@tanstack/ai"
import { toRunErrorPayload } from "@tanstack/ai/adapter-internals"
import { BaseTranscriptionAdapter } from "@tanstack/ai/adapters"
import type { AutomaticSpeechRecognitionPipeline, ProgressInfo } from "@huggingface/transformers"

import type { Availability, DownloadProgressCallback } from "./client.js"
import type { Device, Dtype } from "./protocol.js"

export type TransformersJsTranscriptionConfig = {
  /** "webgpu" or "wasm" (the CPU): Transformers.js's default otherwise. */
  device?: Device
  /** The ONNX weights to load: Transformers.js's default otherwise. */
  dtype?: Dtype
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
  private readonly loadConfig: TransformersJsTranscriptionConfig
  private recognizer: Promise<AutomaticSpeechRecognitionPipeline> | undefined
  private ready = false

  constructor(config: TransformersJsTranscriptionConfig, model: TModel) {
    super(model, {})
    this.loadConfig = config
  }

  /** "unavailable" without WebAssembly or Web Audio, "available" once loaded, "downloading" while it loads, else "downloadable". */
  async availability(): Promise<Availability> {
    if (typeof WebAssembly === "undefined" || typeof AudioContext === "undefined") return "unavailable"
    if (!this.recognizer) return "downloadable"
    return this.ready ? "available" : "downloading"
  }

  /** Loads the model ahead of the first transcription, with its download's progress. Resolves to this adapter. */
  create(options: { onDownloadProgress?: DownloadProgressCallback } = {}): Promise<this> {
    const ready = this.load(options.onDownloadProgress).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Frees the model; the next call loads it again. */
  async destroy(): Promise<void> {
    const recognizer = this.recognizer
    this.recognizer = undefined
    this.ready = false
    await (await recognizer?.catch(() => undefined))?.dispose()
  }

  /** The pipeline, created once per adapter (again after a failed load). */
  private load(onDownloadProgress?: DownloadProgressCallback): Promise<AutomaticSpeechRecognitionPipeline> {
    const listeners = [this.loadConfig.onDownloadProgress, onDownloadProgress].filter((listener) => !!listener)
    if (this.recognizer) {
      if (listeners.length) void this.recognizer.then(() => listeners.forEach((listener) => listener(1)), () => undefined)
      return this.recognizer
    }
    const { device, dtype } = this.loadConfig
    const recognizer = import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("automatic-speech-recognition", this.model, {
          ...(device && { device }),
          ...(dtype && { dtype }),
          progress_callback: (info: ProgressInfo) => {
            if (info.status === "progress_total" && info.total) {
              for (const listener of listeners) listener(Math.min(1, info.loaded / info.total))
            }
          }
        }) as Promise<AutomaticSpeechRecognitionPipeline>
    )
    this.recognizer = recognizer
    recognizer.then(
      () => {
        this.ready = this.recognizer === recognizer
        for (const listener of listeners) listener(1)
      },
      () => {
        if (this.recognizer === recognizer) this.recognizer = undefined
      }
    )
    return recognizer
  }

  async transcribe(options: TranscriptionOptions<TransformersJsTranscriptionModelOptions>): Promise<TranscriptionResult> {
    const { logger, modelOptions, language, responseFormat } = options
    const model = options.model as TModel
    try {
      if (options.prompt !== undefined) throw new Error("Transformers.js's Whisper pipeline takes no prompt: leave `prompt` out.")
      logger.request(`activity=transcription provider=${this.name} model=${model}`, { provider: this.name, model })
      const [recognizer, { read_audio }] = await Promise.all([this.load(), import("@huggingface/transformers")])
      const { url, release } = audioUrl(options.audio)
      let samples: Float32Array
      try {
        samples = await read_audio(url, SAMPLE_RATE)
      } finally {
        release()
      }
      options.abortSignal?.throwIfAborted()
      const timestamps = responseFormat === "verbose_json"
      const output = (await recognizer(samples, {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(language && { language }),
        ...(timestamps && { return_timestamps: true }),
        ...modelOptions
      })) as { text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }
      const duration = samples.length / SAMPLE_RATE
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
