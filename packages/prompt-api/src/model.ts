/**
 * The browser's built-in model: whether this browser has one, and its
 * sessions. The browser downloads the model once for all sites (Chrome
 * keeps it in its profile) and loads it when a session is created.
 */
import { languageModel } from "./types.js"
import type {
  Availability,
  DownloadProgressCallback,
  DownloadProgressEvent,
  LanguageModelCreateOptions,
  LanguageModelSession
} from "./types.js"

export type { Availability, SamplingMode } from "./types.js"

/** Kinds of input besides text a session can be told to expect. */
export type MediaInput = "image" | "audio"

/** Languages the model is told to expect, in and out, by default. */
export const DEFAULT_LANGUAGES = ["en"] as const

export const NO_PROMPT_API =
  "This browser has no built-in language model (the Prompt API). It's in Chrome and Edge on desktop."
export const MODEL_UNAVAILABLE =
  "This browser's built-in model can't run on this device (not enough memory, GPU or disk space, or turned off by policy)."

/** An error whose message is already written for the user. */
export class PromptApiError extends Error {
  override readonly name = "PromptApiError"
}

/**
 * What every session expects: text in and out in the languages given (Chrome
 * checks its safety filters for the output language), and images or audio
 * in if the conversation has them.
 */
export function baseOptions(
  languages: ReadonlyArray<string> = DEFAULT_LANGUAGES,
  media: ReadonlyArray<MediaInput> = []
): LanguageModelCreateOptions {
  return {
    expectedInputs: [{ type: "text", languages: [...languages] }, ...media.map((type) => ({ type }))],
    expectedOutputs: [{ type: "text", languages: [...languages] }]
  }
}

/**
 * Whether this browser can run its built-in model with these options:
 * "available" (on the device), "downloadable" or "downloading" (it
 * downloads when a session is created), or "unavailable".
 */
export async function promptApiAvailability(options: LanguageModelCreateOptions): Promise<Availability> {
  const api = languageModel()
  if (!api) return "unavailable"
  try {
    return await api.availability(options)
  } catch {
    return "unavailable"
  }
}

/** What a failed create() means for the user. */
function createErrorText(error: unknown) {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError") {
    return "The browser wants a click on the page before it downloads its built-in model. Send the message again."
  }
  if (name === "NotSupportedError") return MODEL_UNAVAILABLE
  if (name === "QuotaExceededError") return "Not enough disk space for the browser's built-in model."
  if (name === "NetworkError") {
    return "The browser couldn't download its built-in model. Check the connection and try again."
  }
  return `The built-in model couldn't start: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * A new session, checked with `availability()` first. `onDownloadProgress`
 * hears a download, 0 to 1 (Chrome reports 0 and 1 on every create, so only
 * the steps between are passed on), then 1 once the session has started.
 * Aborting `signal` stops the create and destroys the session.
 */
export async function createSession(
  options: LanguageModelCreateOptions,
  signal?: AbortSignal,
  onDownloadProgress?: DownloadProgressCallback
): Promise<LanguageModelSession> {
  const api = languageModel()
  if (!api) throw new PromptApiError(NO_PROMPT_API)
  signal?.throwIfAborted()
  const { expectedInputs, expectedOutputs, samplingMode, temperature, topK } = options
  if ((await promptApiAvailability({ expectedInputs, expectedOutputs, samplingMode, temperature, topK })) === "unavailable") {
    throw new PromptApiError(
      options.expectedInputs?.some((e) => e.type !== "text")
        ? "This browser's built-in model can't read images or audio on this device."
        : MODEL_UNAVAILABLE
    )
  }
  try {
    const session = await api.create({
      ...options,
      ...(signal && { signal }),
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          const { loaded } = event as DownloadProgressEvent
          if (loaded > 0 && loaded < 1) onDownloadProgress?.(loaded)
        })
      }
    })
    onDownloadProgress?.(1)
    return session
  } catch (error) {
    signal?.throwIfAborted()
    throw new PromptApiError(createErrorText(error), { cause: error })
  }
}
