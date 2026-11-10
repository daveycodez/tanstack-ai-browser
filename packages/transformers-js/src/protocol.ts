/**
 * Messages between the page (client.ts) and the worker (worker.ts). The
 * worker holds one model and runs one generation at a time.
 */

/** Where the model runs: WebGPU, or the CPU through WebAssembly. */
export type Device = "webgpu" | "wasm"

/** The ONNX weights to load (Transformers.js's `dtype`). */
export type Dtype = "q4f16" | "q4" | "fp16" | "fp32" | "q8" | "int8" | "uint8" | "bnb4"

/** The model to load, and how. Left out, the worker picks the device and weights. */
export type LoadSettings = { model: string; device?: Device; dtype?: Dtype }

/** A chat message as Hugging Face chat templates read it. */
export type TemplateMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
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

/** Transformers.js `generate()` options. */
export type GenerationOptions = {
  max_new_tokens: number
  do_sample: boolean
  temperature?: number
  top_k?: number
  top_p?: number
  repetition_penalty?: number
}

export type GenerateRequest = {
  messages: Array<TemplateMessage>
  options: GenerationOptions
  tools?: Array<TemplateTool>
  /** The chat template's `enable_thinking`. */
  enableThinking: boolean
}

export type WorkerRequest =
  | { type: "load"; settings: LoadSettings }
  | ({ type: "generate" } & GenerateRequest)
  | { type: "interrupt" }

export type WorkerReply =
  /** The download's progress across the model's files, 0 to 1. */
  | { status: "progress"; progress: number }
  | { status: "ready" }
  /** Generated text. */
  | { status: "update"; output: string }
  /** The generation ended (finished, interrupted or out of tokens), with its token counts. */
  | { status: "complete"; inputTokens: number; outputTokens: number }
  | { status: "error"; message: string }
