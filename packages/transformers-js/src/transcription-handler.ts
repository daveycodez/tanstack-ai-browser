/**
 * Whisper's side of the transcription protocol (protocol.ts): loads one
 * model as Transformers.js's own `automatic-speech-recognition` pipeline
 * and transcribes samples with it. It runs on the page (the adapter imports
 * it at its first use) or in a Web Worker of your own
 * (`self.onmessage = (event) => handler.onmessage(event)`).
 */
import { pipeline } from "@huggingface/transformers"
import type { AutomaticSpeechRecognitionPipeline, ProgressInfo } from "@huggingface/transformers"

import type { TranscriptionLoadSettings, TranscriptionReply, TranscriptionRequest } from "./protocol.js"

export class TransformersJsTranscriptionWorkerHandler {
  private recognizer: AutomaticSpeechRecognitionPipeline | null = null
  private readonly post: (reply: TranscriptionReply) => void

  /** `post` sends a reply to the page: the worker's own `postMessage` by default. */
  constructor(post?: (reply: TranscriptionReply) => void) {
    this.post = post ?? ((reply) => (self as unknown as { postMessage(reply: TranscriptionReply): void }).postMessage(reply))
  }

  /** A message from the page: `self.onmessage = (event) => handler.onmessage(event)`. */
  onmessage({ data }: { data: TranscriptionRequest }): void {
    const fail = (error: unknown) => this.post({ status: "error", message: error instanceof Error ? error.message : String(error) })
    if (data.type === "load") void this.load(data.settings).catch(fail)
    else if (data.type === "unload") void this.unload().then(() => this.post({ status: "unloaded" }), fail)
    else void this.transcribe(data.samples, data.options).catch(fail)
  }

  private async unload() {
    const previous = this.recognizer
    this.recognizer = null
    await previous?.dispose()
  }

  private async load({ model, device, dtype }: TranscriptionLoadSettings) {
    await this.unload()
    this.recognizer = (await pipeline("automatic-speech-recognition", model, {
      ...(device && { device }),
      ...(dtype && { dtype }),
      progress_callback: (info: ProgressInfo) => {
        if (info.status === "progress_total" && info.total) {
          this.post({ status: "progress", progress: Math.min(1, info.loaded / info.total) })
        }
      }
    })) as AutomaticSpeechRecognitionPipeline
    this.post({ status: "ready" })
  }

  private async transcribe(samples: Float32Array, options: Record<string, unknown>) {
    if (!this.recognizer) throw new Error("No model is loaded.")
    const output = (await this.recognizer(samples, options)) as Extract<TranscriptionReply, { status: "result" }>
    this.post({ status: "result", text: output.text, ...(output.chunks && { chunks: output.chunks }) })
  }
}
