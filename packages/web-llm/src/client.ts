/**
 * The page's side of WebLLM: an engine in a Web Worker this package starts
 * (worker.ts), holding one model at a time; loading another, or the same
 * with other settings, replaces it (WebLLM's `reload`). Chat models share
 * one engine and embedding models another, so embedding doesn't unload the
 * chat model. An adapter given a worker of its own (`worker`) has that
 * worker's engine instead, shared by every adapter given it. WebLLM downloads models to the browser's cache once, and
 * loads them from there afterwards.
 *
 * WebLLM is the official `@mlc-ai/web-llm` package, unmodified, used
 * through its public API.
 */
import { hasModelInCache, prebuiltAppConfig, WebWorkerMLCEngine } from "@mlc-ai/web-llm"
import type { AppConfig, ChatOptions, MLCEngineConfig } from "@mlc-ai/web-llm"

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
  /** WebLLM's log level and its own progress reports, for this model's load. */
  engineConfig?: Pick<MLCEngineConfig, "logLevel" | "initProgressCallback">
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

/** One engine, in a worker (the caller's, or one started here under `name`), and the model it holds. */
function engineSlot(name: string, worker?: Worker) {
  let engine: WebWorkerMLCEngine | null = null
  /** Settles when the last caller to `acquire` the engine releases it. */
  let turns: Promise<void> = Promise.resolve()
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
    /** The load's own listener for WebLLM's reports, as WebLLM writes them. */
    report: MLCEngineConfig["initProgressCallback"]
  } | null = null

  /** Each engine's failure: it rejects when the engine's worker fails (WebLLM itself never notices). */
  const failures = new WeakMap<WebWorkerMLCEngine, Promise<never>>()
  /** A caller's worker that failed before it ever answered: its script didn't load, so nothing can run in it. */
  let dead: Error | null = null
  /** Whether the worker has sent anything: one that has is running. */
  let answered = false
  const failedToLoad = () => new Error("WebLLM's worker failed to load its script.")
  if (worker) {
    // From the adapter's creation on, so a failure before its first call isn't missed.
    worker.addEventListener("message", () => {
      answered = true
    })
    worker.addEventListener("error", () => {
      if (!engine && !answered) dead ??= failedToLoad()
    })
  }

  /**
   * The engine, in its worker. Its load progress goes to the waiting callers
   * while the model downloads. If the worker fails (its script doesn't load,
   * it throws, or a message can't be read), what waits on the engine rejects
   * and the engine is dropped: the package's own worker is ended and the
   * next call starts another; a caller's worker gets a new engine, unless
   * it never ran.
   */
  function getEngine(): WebWorkerMLCEngine {
    if (engine) return engine
    if (dead) throw dead
    const host = worker ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module", name })
    const created = new WebWorkerMLCEngine(host, {
      initProgressCallback: (report) => {
        const current = loaded
        current?.report?.(report)
        const { progress } = report
        if (!current?.downloading) return
        // WebLLM reports the download, then loading the stored files from 0
        // again: the download ends at its first 1.
        if (progress >= 1) current.downloading = false
        else for (const listener of current.listeners) listener(progress)
      }
    })
    if (!worker) answered = false
    const onMessage = () => {
      answered = true
    }
    let fail = (_error: Error) => undefined as void
    const failure = new Promise<never>((_, reject) => (fail = reject))
    // Nothing may be waiting when it fails.
    failure.catch(() => undefined)
    const onFailure = (event: Event) => {
      const detail = (event as ErrorEvent).message
      const error = detail ? new Error(`WebLLM's worker failed: ${detail}`) : answered ? new Error("WebLLM's worker failed.") : failedToLoad()
      host.removeEventListener("error", onFailure)
      host.removeEventListener("messageerror", onFailure)
      host.removeEventListener("message", onMessage)
      if (!worker) host.terminate()
      else if (!answered) dead = error
      if (engine === created) {
        engine = null
        loaded = null
      }
      fail(error)
    }
    host.addEventListener("error", onFailure)
    host.addEventListener("messageerror", onFailure)
    host.addEventListener("message", onMessage)
    failures.set(created, failure)
    engine = created
    return created
  }

  /** `promise`, unless `engine`'s worker fails first. */
  const guard = <T>(engine: WebWorkerMLCEngine, promise: Promise<T>): Promise<T> =>
    Promise.race([promise, failures.get(engine) ?? promise])

  return {
    guard,

    /** A streamed reply's chunks, ending with the worker's failure if it fails midway. */
    async *guardStream<T>(engine: WebWorkerMLCEngine, stream: AsyncIterable<T>): AsyncGenerator<T> {
      const chunks = stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await guard(engine, chunks.next())
        if (next.done) return
        yield next.value
      }
    },

    /**
     * Waits for the engine to itself, after the callers before, and resolves
     * to the call that hands it on. WebLLM queues generations but stops them
     * with one engine-wide interrupt, so a request holds the engine from its
     * load to its reply's end, and one cancelled while it waits (`signal`)
     * gives up its turn without touching the engine.
     */
    async acquire(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted()
      let release = () => undefined as void
      const mine = new Promise<void>((resolve) => (release = resolve))
      const before = turns
      turns = before.then(() => mine)
      try {
        await abortable(before, signal)
      } catch (error) {
        void before.then(release)
        throw error
      }
      return release
    },

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
          listeners: new Set<DownloadProgressCallback>(),
          report: settings.engineConfig?.initProgressCallback
        }
        loaded = current
        current.promise = (async () => {
          current.downloading = !(await stored(model, settings.appConfig))
          // The worker keeps the last catalog it was given: give it this load's.
          engine.setAppConfig(settings.appConfig ?? prebuiltAppConfig)
          if (settings.engineConfig?.logLevel) engine.setLogLevel(settings.engineConfig.logLevel)
          await guard(engine, engine.reload(model, settings.chatOptions))
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
      await guard(engine, engine.unload())
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

export type EngineSlot = ReturnType<typeof engineSlot>

/** The engine chat models load in. */
const chatEngine = engineSlot("web-llm")

/** The engine embedding models load in. */
const embeddingEngine = engineSlot("web-llm-embedding")

/** The engines in the callers' own workers: one a worker, as each worker's handler holds one. */
const workerEngines = new WeakMap<Worker, EngineSlot>()

/**
 * The engine an adapter's models load in: its own worker's (shared by every
 * adapter given that worker, whichever kind), else the package's engine for
 * chat or for embedding.
 */
export function engineFor(kind: "chat" | "embedding", worker?: Worker): EngineSlot {
  if (!worker) return kind === "chat" ? chatEngine : embeddingEngine
  let slot = workerEngines.get(worker)
  if (!slot) workerEngines.set(worker, (slot = engineSlot("web-llm", worker)))
  return slot
}
