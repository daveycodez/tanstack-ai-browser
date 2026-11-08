/**
 * The browser's built-in model: whether this browser has one, which one it
 * is, and its download. The browser downloads the model once for all sites
 * (Chrome keeps it in its profile) and loads it when a session is created.
 */
import { abortError, LoadWaiters } from "./shared-load.js"
import { createStore } from "./store.js"
import { languageModel } from "./types.js"
import type {
  Availability,
  DownloadProgressEvent,
  LanguageModelCoreOptions,
  LanguageModelCreateOptions,
  LanguageModelSession,
  SamplingMode
} from "./types.js"

export type { Availability, SamplingMode } from "./types.js"

/** The built-in model's loading status, kept here to tell a first session from later ones. */
type ModelStatus =
  | { state: "idle" }
  | {
      state: "loading"
      /** 0-1 of the browser's download of the model. */
      progress: number
      /** True when the model is already on the device, not downloading. */
      cached: boolean
      /** Bytes downloaded so far: the Prompt API never says, so always unset. */
      loadedBytes?: number
      /** Bytes of the whole download: always unset, as `loadedBytes`. */
      totalBytes?: number
    }
  | { state: "ready" }
  | { state: "error"; message: string }

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
 * checks its safety filters for the output language), images or audio in if
 * the conversation has them, and tool calls if the browser runs tools.
 */
export function baseOptions(
  languages: ReadonlyArray<string> = DEFAULT_LANGUAGES,
  {
    media = [],
    nativeTools = false
  }: { media?: ReadonlyArray<MediaInput>; nativeTools?: boolean } = {}
): LanguageModelCreateOptions {
  return {
    expectedInputs: [
      { type: "text", languages: [...languages] },
      ...media.map((type) => ({ type })),
      ...(nativeTools
        ? [{ type: "tool-call" as const }, { type: "tool-response" as const }]
        : [])
    ],
    expectedOutputs: [
      { type: "text", languages: [...languages] },
      ...(nativeTools ? [{ type: "tool-call" as const }] : [])
    ]
  }
}

/**
 * Whether this browser can run its built-in model: "available" (on the
 * device), "downloadable" or "downloading" (it downloads when a session is
 * created), or "unavailable" (no Prompt API, or the device can't run it).
 * Give it what the sessions will use: the `languages`, any `samplingMode`,
 * and `inputs` besides text (images need more of the device, audio a GPU).
 */
export async function promptApiAvailability(
  languages?: ReadonlyArray<string>,
  options: {
    samplingMode?: SamplingMode
    inputs?: ReadonlyArray<MediaInput>
  } = {}
): Promise<Availability> {
  const api = languageModel()
  if (!api) return "unavailable"
  try {
    return await api.availability({
      ...baseOptions(languages, { media: options.inputs }),
      ...(options.samplingMode && { samplingMode: options.samplingMode })
    })
  } catch {
    return "unavailable"
  }
}

const status = createStore<ModelStatus>({ state: "idle" })


let contextWindow: number | undefined
/** Records a session's context window, the same for every session. */
export function noteContextWindow(session: LanguageModelSession) {
  if (session.contextWindow > 0) contextWindow = session.contextWindow
}

/** Calls a progress callback; one that throws doesn't stop the session. */
function report(listener: ((progress: number) => void) | undefined, progress: number) {
  try {
    listener?.(progress)
  } catch (error) {
    console.error(error)
  }
}

/** What a failed create() means for the user. */
export function createErrorText(error: unknown) {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError") {
    return "The browser wants a click on the page before it downloads its built-in model. Send the message again."
  }
  if (name === "NotSupportedError") return MODEL_UNAVAILABLE
  if (name === "QuotaExceededError") {
    return "Not enough disk space for the browser's built-in model."
  }
  if (name === "NetworkError") {
    return "The browser couldn't download its built-in model. Check the connection and try again."
  }
  return `The built-in model couldn't start: ${error instanceof Error ? error.message : String(error)}`
}

const asksForMedia = (options: LanguageModelCreateOptions) =>
  options.expectedInputs?.some((e) => e.type === "image" || e.type === "audio")

/**
 * A new session, with the model's status kept up to date: until a session
 * has started, it checks `availability()` with the same options and follows
 * the download; after, only a download shows (if the browser removed the
 * model to free space, say). `onDownloadProgress` hears the download, 0 to
 * 1, and 1 when the first session starts. `signal` stops the wait, not the
 * session made: a session given a request's signal would be destroyed by a
 * later abort of that request, after it was kept for the next one.
 */
export async function createLanguageModel(
  options: LanguageModelCreateOptions,
  signal?: AbortSignal,
  onDownloadProgress?: (progress: number) => void
): Promise<LanguageModelSession> {
  const api = languageModel()
  if (!api) {
    status.set({ state: "error", message: NO_PROMPT_API })
    throw new PromptApiError(NO_PROMPT_API)
  }
  signal?.throwIfAborted()
  const {
    expectedInputs,
    expectedOutputs,
    tools,
    samplingMode,
    temperature,
    topK
  } = options
  const core: LanguageModelCoreOptions = {
    expectedInputs,
    expectedOutputs,
    ...(tools && { tools }),
    ...(samplingMode !== undefined && { samplingMode }),
    ...(temperature !== undefined && { temperature }),
    ...(topK !== undefined && { topK })
  }
  const starting = status.get().state !== "ready"
  if (starting) {
    const availability = await api.availability(core).catch(() => "unavailable")
    signal?.throwIfAborted()
    if (availability === "unavailable") {
      if (asksForMedia(options)) {
        throw new PromptApiError(
          "This browser's built-in model can't read images or audio on this device."
        )
      }
      status.set({ state: "error", message: MODEL_UNAVAILABLE })
      throw new PromptApiError(MODEL_UNAVAILABLE)
    }
    if (status.get().state !== "loading") {
      const downloaded = availability === "available"
      status.set({
        state: "loading",
        progress: downloaded ? 1 : 0,
        cached: downloaded
      })
    }
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const session = await api.create({
      ...options,
      signal: controller.signal,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          // Every create() reports 0 and 1, downloading or not.
          const { loaded } = event as DownloadProgressEvent
          if (loaded > 0 && loaded < 1) {
            status.set({ state: "loading", progress: loaded, cached: false })
            report(onDownloadProgress, loaded)
          }
        })
      }
    })
    if (signal?.aborted) {
      session.destroy()
      signal.throwIfAborted()
    }
    noteContextWindow(session)
    if (status.get().state !== "ready") status.set({ state: "ready" })
    if (starting) report(onDownloadProgress, 1)
    return session
  } catch (error) {
    if (signal?.aborted) {
      if (starting && status.get().state === "loading") {
        status.set({ state: "idle" })
      }
      throw error
    }
    const message = createErrorText(error)
    if (starting && !asksForMedia(options)) {
      status.set({ state: "error", message })
    }
    throw new PromptApiError(message, { cause: error })
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Tokens a session holds, prompt and replies together (9,216 for Gemini
 * Nano in Chrome 156). Creates and frees a session to read it if none was
 * made yet; undefined while the model isn't on the device.
 */
export async function promptApiContextWindow(
  languages?: ReadonlyArray<string>
): Promise<number | undefined> {
  if (contextWindow) return contextWindow
  if ((await promptApiAvailability(languages)) !== "available") return undefined
  const session = await createLanguageModel(baseOptions(languages))
  session.destroy()
  return contextWindow
}

/**
 * The model starting for `loadPromptApiModel`'s callers: its native
 * create(), the controller that aborts it, and the callers waiting on it.
 */
let loading: { promise: Promise<void>; waiters: LoadWaiters } | null = null

type LoadOptions = {
  languages?: ReadonlyArray<string>
  signal?: AbortSignal
  onDownloadProgress?: (progress: number) => void
}

/**
 * Downloads the model if it isn't on the device, and loads it, with the
 * download's progress, 0 to 1, then 1 once it's ready (at once if it
 * already is). `chat()` doesn't need it (its first session does the same),
 * but the browser asks for a click on the page before a download: call it
 * from the click that turns the model on. Aborting `signal` rejects this
 * call at once with an AbortError and stops its progress reports; the
 * browser's `LanguageModel.create()` is aborted when no other caller still
 * waits on it. A model that started before is asked about again: the
 * browser may have removed it since (to free space, say), and then it's
 * loaded again.
 */
export async function loadPromptApiModel(options: LoadOptions = {}): Promise<void> {
  const { signal } = options
  if (signal?.aborted) throw abortError()
  if (status.get().state === "ready") {
    const availability = await promptApiAvailability(options.languages)
    if (signal?.aborted) throw abortError()
    if (availability === "available") {
      report(options.onDownloadProgress, 1)
      return
    }
    // No longer on the device: the next session starts it again.
    if (status.get().state === "ready") status.set({ state: "idle" })
  }
  return startModel(options)
}

function startModel(options: LoadOptions): Promise<void> {
  const { signal, onDownloadProgress } = options
  if (!loading) {
    const controller = new AbortController()
    // The last caller waiting gave up: abort the browser's create().
    const waiters = new LoadWaiters(() => controller.abort(abortError()))
    const promise = createLanguageModel(
      baseOptions(options.languages),
      controller.signal,
      (progress) => waiters.report(progress)
    )
      .then((session) => session.destroy())
      .finally(() => {
        if (loading?.promise === promise) loading = null
        waiters.settle()
      })
    promise.catch(() => undefined)
    loading = { promise, waiters }
  }
  return loading.waiters.wait(loading.promise, { onDownloadProgress, signal })
}
