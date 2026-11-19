/**
 * The native side of the adapter: ML Kit's GenAI Prompt API, reached through
 * the Capacitor plugin on Android (android/src). Any host can stand in for it
 * by implementing `MlKitNative`.
 */
import type { PluginListenerHandle } from "@capacitor/core"

/**
 * Which of ML Kit's models runs (its `ModelConfig`): the `releaseStage`
 * ("stable", the default, or "preview", a newer model for testing) and the
 * `preference` ("full", the default, or "fast", a smaller, quicker one).
 */
export type MlKitModelConfig = {
  releaseStage?: "stable" | "preview"
  preference?: "full" | "fast"
}

/** What a model can do, as ML Kit reports it (its `Feature`s). */
export type MlKitFeature = "systemPrompt" | "thinkingMode" | "prefixCaching" | "structuredOutput" | "functionCalling"

export type NativeAvailability = {
  /** ML Kit's `FeatureStatus`. */
  status: "unavailable" | "downloadable" | "downloading" | "available"
  /** Why the model can't run, or why it couldn't be asked about: an error's code. */
  reason?: string
  /** The model on the device, as ML Kit names it ("nano-v4-full"). */
  baseModelName?: string
  /** Tokens a request and its response share. */
  tokenLimit?: number
  features?: Array<MlKitFeature>
}

/**
 * A schema as ML Kit's `FunctionSchema` takes it: the JSON Schema keywords it
 * has (schema.ts reads JSON Schema into it). No `type`: any of `anyOf`.
 */
export type NativeSchema = {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null"
  description?: string
  title?: string
  properties?: Record<string, NativeSchema>
  required?: Array<string>
  enum?: Array<string>
  format?: string
  nullable?: boolean
  items?: NativeSchema
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  anyOf?: Array<NativeSchema>
}

export type NativeTool = { name: string; description: string; parameters?: NativeSchema }

/** A part of a turn: text, an image (base64), a tool call of the model's, or a tool's result. */
export type NativePart =
  | { text: string }
  | { image: string }
  | { functionCall: { id?: string; name: string; arguments: Record<string, unknown> } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } }

/** A turn of the conversation. Tool results are a user turn's parts. */
export type NativeContent = { role: "user" | "model"; parts: Array<NativePart> }

/** A request: ML Kit keeps no conversation, so each one holds all of it. */
export type NativeRequest = {
  model?: MlKitModelConfig
  systemInstruction?: string
  contents: Array<NativeContent>
  tools?: Array<NativeTool>
  options?: {
    /** 0 to 1. */
    temperature?: number
    topK?: number
    seed?: number
    maxOutputTokens?: number
    /** Thinking mode, where the model has it. */
    enableThinking?: boolean
    /** With a `schema`, false: it stays out of the model's prompt (ML Kit still holds the answer to it). */
    includeSchemaInPrompt?: boolean
  }
  /**
   * Holds the answer to this schema with ML Kit's structured output: an object
   * as held-schema.ts allows. The answer comes whole, in `done`, as JSON.
   */
  schema?: NativeSchema
}

/** What the native side sends: a response's events (`requestId`), and a download's progress (`downloadId`). */
export type NativeEvent =
  | { requestId: string; type: "thought"; text: string }
  | { requestId: string; type: "delta"; text: string }
  | {
      requestId: string
      type: "done"
      text: string
      finishReason: "stop" | "length" | "other"
      toolCalls?: Array<{ id: string; name: string; arguments: string }>
    }
  | { requestId: string; type: "error"; code: string; message: string }
  | { downloadId: string; type: "download"; downloaded: number; total: number }

export interface MlKitNative {
  availability(options?: { model?: MlKitModelConfig }): Promise<NativeAvailability>
  /** Downloads the model if it isn't on the device; resolves once it's there. Progress comes as `download` events. */
  download(options: { downloadId: string; model?: MlKitModelConfig }): Promise<void>
  /** Loads the model into memory ahead of the first request. */
  warmup(options?: { model?: MlKitModelConfig }): Promise<void>
  /** The tokens of a request's input. */
  countTokens(options: NativeRequest): Promise<{ totalTokens: number }>
  /** Starts a response; it comes as events. */
  generate(options: NativeRequest & { requestId: string }): Promise<void>
  /** Stops a response. */
  cancel(options: { requestId: string }): Promise<void>
  addListener(eventName: "event", listener: (event: NativeEvent) => void): Promise<PluginListenerHandle>
}

let loading: Promise<{ plugin: MlKitNative }> | undefined
/**
 * The plugin, loading Capacitor on first use: pages elsewhere never load it.
 * It's wrapped: a Capacitor plugin answers every property, `then` too, so a
 * promise of the plugin itself would wait on it forever.
 */
const capacitor = () =>
  (loading ??= import("@capacitor/core").then(({ registerPlugin }) => ({ plugin: registerPlugin<MlKitNative>("MlKit") })))

/**
 * The Capacitor plugin (Android), loading Capacitor on its first call.
 * Elsewhere its calls reject: Capacitor has no web or iOS version of it.
 */
export const MlKit: MlKitNative = {
  availability: async (options) => (await capacitor()).plugin.availability(options),
  download: async (options) => (await capacitor()).plugin.download(options),
  warmup: async (options) => (await capacitor()).plugin.warmup(options),
  countTokens: async (options) => (await capacitor()).plugin.countTokens(options),
  generate: async (options) => (await capacitor()).plugin.generate(options),
  cancel: async (options) => (await capacitor()).plugin.cancel(options),
  addListener: async (name, listener) => (await capacitor()).plugin.addListener(name, listener)
}
