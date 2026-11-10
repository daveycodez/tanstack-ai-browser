/**
 * The page's side of WebLLM: an engine in a Web Worker this package starts
 * (worker.ts), holding one model at a time; loading another, or the same
 * with other settings, replaces it (WebLLM's `reload`). Chat models share
 * one engine and embedding models another, so embedding doesn't unload the
 * chat model. WebLLM downloads models to the browser's cache once, and
 * loads them from there afterwards.
 *
 * WebLLM is the official `@mlc-ai/web-llm` package, unmodified, used
 * through its public API.
 */
import { hasModelInCache, WebWorkerMLCEngine } from "@mlc-ai/web-llm"
import type { AppConfig, ChatOptions } from "@mlc-ai/web-llm"

/**
 * Where a model stands in this browser, with the Prompt API's values
 * (`LanguageModel.availability()`).
 */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

/** What a model loads with. A load with other settings loads the model again. */
export type LoadSettings = {
  /** WebLLM's chat options (`context_window_size`, …); the model's own otherwise. */
  chatOptions?: ChatOptions
  /** WebLLM's model list; its `prebuiltAppConfig` otherwise. */
  appConfig?: AppConfig
}

/** Waits for `promise` until `signal` aborts; the load goes on. */
const abortable = <T>(promise: Promise<T>, signal: AbortSignal | undefined) =>
  signal
    ? Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      ])
    : promise

/** Whether `model`'s files are in WebLLM's cache. */
const stored = (model: string, appConfig?: AppConfig) => hasModelInCache(model, appConfig)

let webGpu: Promise<boolean> | undefined
/** Whether the browser has WebGPU and gives a GPU adapter, checked once. */
const hasWebGpu = () =>
  (webGpu ??= (async () => {
    const gpu = (globalThis.navigator as (Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }) | undefined)?.gpu
    if (!gpu || typeof Worker === "undefined") return false
    return (await gpu.requestAdapter().catch(() => null)) !== null
  })())

/** One engine, in its own worker, and the model it holds. */
function engineSlot(name: string) {
  let engine: WebWorkerMLCEngine | null = null
  let loaded: {
    model: string
    key: string
    appConfig: AppConfig | undefined
    promise: Promise<void>
    ready: boolean
    /** Whether WebLLM's progress is a download (the model wasn't stored). */
    downloading: boolean
    /** The waiting callers' progress callbacks. */
    listeners: Set<DownloadProgressCallback>
  } | null = null

  /** The engine, in its worker. Its load progress goes to the waiting callers while the model downloads. */
  const getEngine = () =>
    (engine ??= new WebWorkerMLCEngine(new Worker(new URL("./worker.js", import.meta.url), { type: "module", name }), {
      initProgressCallback: ({ progress }) => {
        const current = loaded
        if (!current?.downloading) return
        // WebLLM reports the download, then loading the stored files from 0
        // again: the download ends at its first 1.
        if (progress >= 1) current.downloading = false
        else for (const listener of current.listeners) listener(progress)
      }
    }))

  return {
    /**
     * The model, loaded with `settings` (downloading it the first time), in
     * place of any other. `onDownloadProgress` hears the download, 0 to 1,
     * then 1 once the model is ready. Aborting `signal` stops this caller's
     * wait; `unloadModel` stops the load.
     */
    async loadModel(
      model: string,
      settings: LoadSettings,
      { onDownloadProgress, signal }: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
    ): Promise<WebWorkerMLCEngine> {
      signal?.throwIfAborted()
      const key = JSON.stringify(settings.chatOptions ?? {})
      const engine = getEngine()
      if (loaded?.model !== model || loaded.key !== key || loaded.appConfig !== settings.appConfig) {
        const current = {
          model,
          key,
          appConfig: settings.appConfig,
          promise: Promise.resolve(),
          ready: false,
          downloading: false,
          listeners: new Set<DownloadProgressCallback>()
        }
        loaded = current
        current.promise = (async () => {
          current.downloading = !(await stored(model, settings.appConfig))
          if (settings.appConfig) engine.setAppConfig(settings.appConfig)
          await engine.reload(model, settings.chatOptions)
        })().finally(() => {
          current.downloading = false
        })
        current.promise.then(
          () => {
            current.ready = true
          },
          () => {
            if (loaded === current) loaded = null
          }
        )
      }
      const current = loaded
      if (onDownloadProgress) current.listeners.add(onDownloadProgress)
      try {
        await abortable(current.promise, signal)
        onDownloadProgress?.(1)
        return engine
      } finally {
        if (onDownloadProgress) current.listeners.delete(onDownloadProgress)
      }
    },

    /** Unloads the model, stopping its load. Given a model, only if it's the one loaded. */
    async unloadModel(model?: string) {
      const current = loaded
      if (!current || !engine || (model !== undefined && current.model !== model)) return
      loaded = null
      await engine.unload()
    },

    /**
     * Where `model` stands in this browser, with the Prompt API's values:
     * "unavailable" without WebGPU (or a Web Worker), "downloading" while
     * this page downloads it, "available" when it's loaded or in WebLLM's
     * cache, else "downloadable". It reads storage only.
     */
    async availability(model: string, appConfig?: AppConfig): Promise<Availability> {
      if (!(await hasWebGpu())) return "unavailable"
      if (loaded?.model === model) {
        if (loaded.ready) return "available"
        if (loaded.downloading) return "downloading"
      }
      return (await stored(model, appConfig)) ? "available" : "downloadable"
    }
  }
}

/** The engine chat models load in. */
export const chatEngine = engineSlot("web-llm")

/** The engine embedding models load in. */
export const embeddingEngine = engineSlot("web-llm-embedding")
