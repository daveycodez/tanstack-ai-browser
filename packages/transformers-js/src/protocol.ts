/**
 * Messages between the page (client.ts) and the model's handler
 * (handler.ts), in the package's worker, a worker of the caller's, or on a
 * server in the same process. The handler holds one model and runs one
 * generation at a time.
 */
import type { GenerationConfig } from "@huggingface/transformers"

/** Where the model runs: WebGPU, or the CPU through WebAssembly. */
export type Device = "webgpu" | "wasm"

/** The ONNX weights to load (Transformers.js's `dtype`). */
export type Dtype = "q4f16" | "q4" | "fp16" | "fp32" | "q8" | "int8" | "uint8" | "bnb4"

/**
 * The weights of each of a model's ONNX files, by the file's name
 * (`{ decoder_model_merged: "q4", vision_encoder: "fp16" }`), for a repo
 * that doesn't have every file in one set of weights. Transformers.js's own
 * per-file `dtype`.
 */
export type DtypeByFile = Readonly<Record<string, Dtype>>

/**
 * The model to load, and how. Left out, the handler picks the device and
 * weights. `vision` loads it with its vision encoder and processor
 * (Transformers.js's `AutoModelForImageTextToText`), for images.
 * `localModelPath` and `cacheDir` are Transformers.js's `env` settings of
 * those names, for a server.
 */
export type LoadSettings = {
  model: string
  device?: Device
  dtype?: Dtype | DtypeByFile
  vision?: boolean
  localModelPath?: string
  cacheDir?: string
}

/** A part of a user message's content, as chat templates read it: an image stands in its place. */
export type TemplatePart = { type: "text"; text: string } | { type: "image" }

/** A chat message as Hugging Face chat templates read it. */
export type TemplateMessage = {
  role: "system" | "user" | "assistant" | "tool"
  /** Parts for a user message with images, and for every message of a model whose template reads parts. */
  content: string | Array<TemplatePart>
  /** A mapping, not a JSON string: templates serialize the arguments themselves. */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: unknown } }>
  tool_call_id?: string
  name?: string
}

/** A tool as chat templates take it (`apply_chat_template({ tools })`). */
export type TemplateTool = {
  type: "function"
  function: { name: string; description: string; parameters: unknown }
}

/**
 * Transformers.js's `generate()` settings (its `GenerationConfig`), as a
 * call may set them: the worker sets the streamer and what it returns.
 * Left out, the repo's `generation_config.json` decides.
 */
export type GenerationSettings = Partial<
  Omit<
    GenerationConfig,
    | "streamer"
    | "return_dict_in_generate"
    | "num_return_sequences"
    | "output_attentions"
    | "output_hidden_states"
    | "output_scores"
  >
>

/** A generation's settings, with its cap. */
export type GenerationOptions = GenerationSettings & { max_new_tokens: number }

export type GenerateRequest = {
  messages: Array<TemplateMessage>
  options: GenerationOptions
  tools?: Array<TemplateTool>
  /** The chat template's `enable_thinking`. */
  enableThinking: boolean
  /** The conversation's images, in order (data or http URLs): one for each image part. */
  images?: Array<string>
}

export type WorkerRequest =
  | { type: "load"; settings: LoadSettings }
  | ({ type: "generate" } & GenerateRequest)
  | { type: "interrupt" }
  /** Frees the model; the handler stays, for the next load. */
  | { type: "unload" }

export type WorkerReply =
  /** The download's progress across the model's files, 0 to 1. */
  | { status: "progress"; progress: number }
  | { status: "ready" }
  /** The model was freed. */
  | { status: "unloaded" }
  /** Generated text. */
  | { status: "update"; output: string }
  /** The generation ended (finished, interrupted or out of tokens), with its token counts. */
  | { status: "complete"; inputTokens: number; outputTokens: number }
  | { status: "error"; message: string }

/** The Whisper model to load, and how: Transformers.js's defaults where left out. */
export type TranscriptionLoadSettings = { model: string; device?: Device; dtype?: Dtype }

/** Requests to Whisper's handler (transcription-handler.ts). It holds one model. */
export type TranscriptionRequest =
  | { type: "load"; settings: TranscriptionLoadSettings }
  /** The audio's samples at 16 kHz, and the pipeline's own options. */
  | { type: "transcribe"; samples: Float32Array; options: Record<string, unknown> }
  | { type: "unload" }

export type TranscriptionReply =
  /** The download's progress across the model's files, 0 to 1. */
  | { status: "progress"; progress: number }
  | { status: "ready" }
  /** The transcript, with timed chunks if asked for. */
  | { status: "result"; text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }
  | { status: "unloaded" }
  | { status: "error"; message: string }
