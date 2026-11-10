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

/** Every kind of input besides text, in the order `availableInputModalities` asks. */
export const MEDIA_INPUTS: ReadonlyArray<MediaInput> = ["image", "audio"]

/** Languages the model is told to expect, in and out, by default. */
export const DEFAULT_LANGUAGES = ["en"] as const

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
  return (await languageModel()?.availability(options)) ?? "unavailable"
}

/**
 * A new session. `onDownloadProgress` hears a download, 0 to 1 (Chrome
 * reports 0 and 1 on every create, so only the steps between are passed
 * on), then 1 once the session has started. Aborting `signal` stops the
 * create and destroys the session.
 */
export async function createSession(
  options: LanguageModelCreateOptions,
  signal?: AbortSignal,
  onDownloadProgress?: DownloadProgressCallback
): Promise<LanguageModelSession> {
  const api = languageModel()
  if (!api) throw new Error("This browser has no Prompt API (LanguageModel).")
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
}
