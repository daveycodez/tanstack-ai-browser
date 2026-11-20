/**
 * The parts of the Prompt API (https://github.com/webmachinelearning/prompt-api)
 * this package uses. TypeScript's DOM library has no types for it yet.
 * Shapes follow the spec and `@types/dom-chromium-ai`, kept here instead of
 * depending on that package: it declares `LanguageModel` as a global (in
 * every app that uses this package). Tool use is the spec's open loop: the
 * session declares `tools`, the model's calls come back as `tool-call`
 * content, and results go back as `tool-response` content (where the
 * browser has it: see `toolClasses`). Names follow the spec: `contextUsage`,
 * `contextWindow` and `contextoverflow` (web pages no longer have the old
 * `inputUsage`, `inputQuota` and `quotaoverflow`).
 */

export type Availability =
  "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

/** Sampling presets, for web pages (the raw `temperature` and `topK` are for extensions). */
export type SamplingMode =
  | "most-predictable"
  | "predictable"
  | "slightly-predictable"
  | "balanced"
  | "slightly-creative"
  | "creative"
  | "most-creative"

export type LanguageModelMessageType = "text" | "image" | "audio" | "tool-call" | "tool-response"

export type LanguageModelExpected = {
  type: LanguageModelMessageType
  languages?: Array<string>
}

/**
 * A piece of a message: text, an image (`Blob`, `ImageBitmap`, canvas...)
 * or audio (`Blob`, `AudioBuffer`...).
 */
export type LanguageModelContent = {
  type: LanguageModelMessageType
  value: unknown
}

/** A tool the session declares: the model's calls to it come back as `tool-call` content. */
export type LanguageModelTool = {
  name: string
  description: string
  /** A JSON Schema with `type: "object"`. */
  inputSchema: object
}

export type LanguageModelMessage = {
  role: "system" | "user" | "assistant"
  content: string | Array<LanguageModelContent>
}

/** Options `availability()` takes, which `create()` takes too. */
export type LanguageModelCoreOptions = {
  expectedInputs?: Array<LanguageModelExpected>
  expectedOutputs?: Array<LanguageModelExpected>
  /** Web pages get it only with Chrome's Sampling Parameters origin trial. */
  samplingMode?: SamplingMode
  /** Extensions only; web pages ignore them. Chrome refuses them together with `samplingMode`. */
  temperature?: number
  topK?: number
}

export type LanguageModelCreateOptions = LanguageModelCoreOptions & {
  initialPrompts?: Array<LanguageModelMessage>
  /** With `tool-call` in `expectedOutputs` and `tool-response` in `expectedInputs`. */
  tools?: Array<LanguageModelTool>
  /** Aborting it destroys the session, during `create()` or after. */
  signal?: AbortSignal
  monitor?: (monitor: EventTarget) => void
}

export type LanguageModelPromptOptions = {
  signal?: AbortSignal
  /** A JSON Schema (or RegExp) the reply must match. */
  responseConstraint?: object
  /**
   * Don't write `responseConstraint` into the model's input: Chrome still holds
   * the reply to it, but the model doesn't read it (the prompt should describe
   * the format then). False by default.
   */
  omitResponseConstraintInput?: boolean
}

export type LanguageModelInput = string | Array<LanguageModelMessage>

export interface LanguageModelSession extends EventTarget {
  /** Tokens the session holds. */
  readonly contextUsage: number
  /** Tokens it can hold. */
  readonly contextWindow: number
  /** The preset the session samples with; null when made with raw parameters. */
  readonly samplingMode?: SamplingMode | null
  prompt(
    input: LanguageModelInput,
    options?: LanguageModelPromptOptions
  ): Promise<string>
  /**
   * The reply in pieces as it's written: text, and with tools, a
   * `{ type: "tool-call", value: LanguageModelToolCall }` per call.
   */
  promptStreaming(
    input: LanguageModelInput,
    options?: LanguageModelPromptOptions
  ): ReadableStream<string | LanguageModelContent> & AsyncIterable<string | LanguageModelContent>
  measureContextUsage(
    input: LanguageModelInput,
    options?: LanguageModelPromptOptions
  ): Promise<number>
  /** A session of its own that holds what this one does. */
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>
  /** Adds messages to what the session holds, without a reply. Not in every browser's Prompt API. */
  append?(input: LanguageModelInput, options?: { signal?: AbortSignal }): Promise<void>
  destroy(): void
}

export type LanguageModelStatic = {
  availability(options?: LanguageModelCoreOptions): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>
}

/** The `downloadprogress` event: `loaded` goes from 0 to 1. */
export type DownloadProgressEvent = Event & { loaded: number; total?: number }

/** The page's `LanguageModel`, or undefined where the browser has none. */
export const languageModel = () =>
  (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel

/** A tool call, as the browser's `LanguageModelToolCall` has it. */
export type LanguageModelToolCall = { callId?: string; callID?: string; name: string; arguments: Record<string, unknown> }

/** What a tool returned, for `LanguageModelToolSuccess`: Chrome takes `text` and `object` here. */
export type LanguageModelToolResultContent = { type: "text"; value: string } | { type: "object"; value: unknown }

/**
 * The browser's tool-use classes: a call as input, and a tool's result or
 * error. Members are passed as `callId` and also `callID` (the spec is
 * renaming it; the constructors ignore a member they don't know).
 */
export type LanguageModelToolClasses = {
  LanguageModelToolCall: new (init: LanguageModelToolCall) => object
  LanguageModelToolSuccess: new (init: { callId: string; callID: string; name: string; result: Array<LanguageModelToolResultContent> }) => object
  LanguageModelToolError: new (init: { callId: string; callID: string; name: string; errorMessage: string }) => object
}

/**
 * The page's tool-use classes, or undefined where the browser has no tool
 * use (Chrome without `chrome://flags/#prompt-api-tool-use`, Edge).
 */
export function toolClasses(): LanguageModelToolClasses | undefined {
  const g = globalThis as Partial<LanguageModelToolClasses>
  return typeof g.LanguageModelToolCall === "function" &&
    typeof g.LanguageModelToolSuccess === "function" &&
    typeof g.LanguageModelToolError === "function"
    ? (g as LanguageModelToolClasses)
    : undefined
}
