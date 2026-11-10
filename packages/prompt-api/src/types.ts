/**
 * The parts of the Prompt API (https://github.com/webmachinelearning/prompt-api)
 * this package uses. TypeScript's DOM library has no types for it yet.
 * Shapes follow the spec and `@types/dom-chromium-ai`, kept here instead of
 * depending on that package: it declares `LanguageModel` as a global (in
 * every app that uses this package). Tools are left out: Chrome's tool use
 * doesn't work on web pages, so the adapter calls tools by prompt
 * (`tools.ts`). Names follow the spec: `contextUsage`,
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

export type LanguageModelMessageType = "text" | "image" | "audio"

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
  /** Aborting it destroys the session, during `create()` or after. */
  signal?: AbortSignal
  monitor?: (monitor: EventTarget) => void
}

export type LanguageModelPromptOptions = {
  signal?: AbortSignal
  /** A JSON Schema (or RegExp) the reply must match. */
  responseConstraint?: object
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
  /** The reply's text, in pieces as it's written. */
  promptStreaming(
    input: LanguageModelInput,
    options?: LanguageModelPromptOptions
  ): ReadableStream<string> & AsyncIterable<string>
  measureContextUsage(
    input: LanguageModelInput,
    options?: LanguageModelPromptOptions
  ): Promise<number>
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
