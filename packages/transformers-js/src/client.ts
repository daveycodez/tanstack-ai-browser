/**
 * The page's side of the model's handler (handler.ts). The handler runs in
 * a Web Worker the package starts, one for the page; in a worker of the
 * caller's (`worker` in the adapter's config); or, on a server (Node.js,
 * which has no Web Worker), in the same process. Each holds one model:
 * loading another replaces it. It loads or generates one thing at a time,
 * so requests wait their turn.
 */
import { givenWorker, inProcess } from "./port.js"
import type { Open, Port } from "./port.js"
import type { GenerateRequest, LoadSettings, WorkerReply, WorkerRequest } from "./protocol.js"

/**
 * Where a model stands in this browser, with the Prompt API's values
 * (`LanguageModel.availability()`).
 */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

export type GenerationEvent =
  | { type: "text"; text: string }
  | { type: "done"; inputTokens: number; cachedTokens?: number; outputTokens: number }

/** Whether this is Node.js: no Web Worker, so the handler runs in this process. */
const onServer = () =>
  typeof Worker === "undefined" && (globalThis as { process?: { release?: { name?: string } } }).process?.release?.name === "node"

/** The package's own worker. */
const ownWorker: Open<WorkerRequest, WorkerReply> = (onReply, onError) => {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "transformers-js" })
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => onReply(data)
  worker.onerror = (event) => {
    event.preventDefault()
    onError(event.message || "The Transformers.js worker failed to start.")
  }
  return { post: (request) => worker.postMessage(request), close: () => worker.terminate() }
}

/** The handler in this process, for a server: Transformers.js is imported at the first request. */
const serverHandler = inProcess<WorkerRequest, WorkerReply, { onmessage(event: { data: WorkerRequest }): void }>(
  (onReply) => import("./handler.js").then(({ TransformersJsWorkerHandler }) => new TransformersJsWorkerHandler(onReply)),
  (handler, request) => handler.onmessage({ data: request })
)

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")

/** The load keys that serve `settings`: its own, and for text, the model with its vision encoder. */
const keys = (settings: LoadSettings) =>
  settings.vision ? [JSON.stringify(settings)] : [JSON.stringify(settings), JSON.stringify({ ...settings, vision: true })]

/**
 * A handler and the model it holds. `open` reaches the handler; `owned`
 * says it's the package's own worker, which unloading ends (a worker's
 * memory is only all freed when it ends). Another is asked to free its model.
 */
function createClient(open: Open<WorkerRequest, WorkerReply>, owned: boolean) {
  let port: Port<WorkerRequest> | null = null
  /** Where the handler's replies go: the load or generation in progress. */
  let listener: ((reply: WorkerReply) => void) | null = null
  /** The model the handler holds or is loading. */
  let current: {
    key: string
    model: string
    ready: boolean
    done: Promise<void>
    listeners: Set<DownloadProgressCallback>
  } | null = null
  /** The load settings of the model the handler holds now: `current` may be a load still waiting its turn. */
  let loaded: string | null = null
  let tail: Promise<unknown> = Promise.resolve()

  function post(request: WorkerRequest) {
    port ??= open(
      (reply) => listener?.(reply),
      (message) => listener?.({ status: "error", message })
    )
    port.post(request)
  }

  /** Waits for the handler's turn; call the release it resolves to when done. */
  function turn(): Promise<() => void> {
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => (release = resolve))
    const ready = tail.then(() => release)
    tail = tail.then(() => held)
    return ready
  }

  /** Stops the generation in progress, which then completes with what it has. */
  function interrupt() {
    port?.post({ type: "interrupt" })
  }

  /**
   * Loads a model in the handler (downloading it the first time) unless it's
   * the one there, sharing a load in progress. `onDownloadProgress` hears the
   * download's progress, then 1 once the model is ready (at once if it is).
   * Aborting `signal` stops this caller's wait, not the load.
   */
  function loadModel(settings: LoadSettings, onDownloadProgress?: DownloadProgressCallback, signal?: AbortSignal): Promise<void> {
    // A model loaded with its vision encoder serves text too: it stays loaded.
    const key = keys(settings).find((k) => k === current?.key) ?? JSON.stringify(settings)
    if (current?.key !== key) {
      const listeners = new Set<DownloadProgressCallback>()
      const load = { key, model: settings.model, ready: false, listeners, done: Promise.resolve() }
      load.done = (async () => {
        const release = await turn()
        try {
          await new Promise<void>((resolve, reject) => {
            listener = (reply) => {
              if (reply.status === "progress") for (const report of listeners) report(reply.progress)
              else if (reply.status === "ready") resolve()
              else if (reply.status === "error") reject(new Error(reply.message))
            }
            loaded = null
            post({ type: "load", settings: JSON.parse(key) as LoadSettings })
          })
          loaded = key
          load.ready = true
          for (const report of listeners) report(1)
        } catch (error) {
          if (current === load) current = null
          throw error
        } finally {
          listeners.clear()
          listener = null
          release()
        }
      })()
      current = load
    }
    const load = current
    if (load.ready) {
      onDownloadProgress?.(1)
      return Promise.resolve()
    }
    if (onDownloadProgress) load.listeners.add(onDownloadProgress)
    if (!signal) return load.done
    if (signal.aborted) return Promise.reject(abortError(signal))
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        if (onDownloadProgress) load.listeners.delete(onDownloadProgress)
        reject(abortError(signal))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      load.done.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
    })
  }

  /**
   * Frees the model's memory, if `model` is the one the handler holds: the
   * package's own worker ends, at once; another handler stops its
   * generation and then frees the model, and stays for the next load.
   */
  async function unloadModel(model: string): Promise<void> {
    if (current?.model !== model) return
    current = null
    if (owned) {
      loaded = null
      port?.close()
      port = null
      listener?.({ status: "error", message: "The model was unloaded." })
      return
    }
    interrupt()
    const release = await turn()
    try {
      // Its load, if it was still waiting, has run by now; a failed one left nothing.
      if (!loaded || (JSON.parse(loaded) as LoadSettings).model !== model) return
      await new Promise<void>((resolve, reject) => {
        listener = (reply) => {
          if (reply.status === "unloaded") resolve()
          else if (reply.status === "error") reject(new Error(reply.message))
        }
        loaded = null
        post({ type: "unload" })
      })
    } finally {
      listener = null
      release()
    }
  }

  /**
   * One generation in the handler, on the model `settings` names: it loads
   * that model (with the download's progress, as `loadModel`), then waits for
   * the handler's turn and holds it from checking the model to the end of the
   * generation, so no other request's load comes between. Yields the text as
   * it streams, then the token counts. Aborting `signal` before the turn
   * means no generation; after, it interrupts it, which still completes with
   * the text so far.
   */
  async function* generate(
    settings: LoadSettings,
    request: GenerateRequest,
    { onDownloadProgress, signal }: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
  ): AsyncGenerator<GenerationEvent> {
    let release: () => void
    for (;;) {
      await loadModel(settings, onDownloadProgress, signal)
      release = await turn()
      // Another request's load may have taken the handler meanwhile: load this model again.
      if (keys(settings).some((key) => key === loaded)) break
      release()
    }
    if (signal?.aborted) {
      release()
      throw abortError(signal)
    }
    const replies: Array<WorkerReply> = []
    let wake: (() => void) | null = null
    let ended = false
    listener = (reply) => {
      replies.push(reply)
      wake?.()
    }
    const next = async () => {
      while (replies.length === 0) await new Promise<void>((resolve) => (wake = resolve))
      const reply = replies.shift() as WorkerReply
      if (reply.status === "complete" || reply.status === "error") ended = true
      return reply
    }
    signal?.addEventListener("abort", interrupt)
    try {
      post({ type: "generate", ...request })
      for (;;) {
        const reply = await next()
        if (reply.status === "update") yield { type: "text", text: reply.output }
        else if (reply.status === "error") throw new Error(reply.message)
        else if (reply.status === "complete") {
          yield {
            type: "done",
            inputTokens: reply.inputTokens,
            ...(reply.cachedTokens !== undefined && { cachedTokens: reply.cachedTokens }),
            outputTokens: reply.outputTokens
          }
          return
        }
      }
    } finally {
      signal?.removeEventListener("abort", interrupt)
      // A reader that stopped early: the handler finishes before the next request.
      if (!ended) {
        interrupt()
        while (!ended && port) await next()
      }
      listener = null
      release()
    }
  }

  /**
   * Where `model` stands here: "unavailable" where nothing can run it (no
   * Web Worker outside Node.js, or no WebAssembly), or without WebGPU unless
   * it `runsOnCpu`; "available" when it's loaded, "downloading" while it
   * loads, "available" when its weights are in Transformers.js's cache, else
   * "downloadable".
   */
  async function availability(model: string, runsOnCpu: boolean): Promise<Availability> {
    if ((typeof Worker === "undefined" && !onServer()) || typeof WebAssembly === "undefined") return "unavailable"
    if (!runsOnCpu && !(await hasWebGpu())) return "unavailable"
    if (current?.model === model) return current.ready ? "available" : "downloading"
    return (await inCache(model)) ? "available" : "downloadable"
  }

  return { loadModel, unloadModel, interrupt, generate, availability }
}

export type Client = ReturnType<typeof createClient>

let webGpu: Promise<boolean> | undefined
/** Whether the browser has WebGPU and gives a GPU adapter, as the handler checks. */
function hasWebGpu(): Promise<boolean> {
  webGpu ??= (async () => {
    const gpu = (globalThis.navigator as (Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }) | undefined)?.gpu
    try {
      return !!gpu && (await gpu.requestAdapter()) !== null
    } catch {
      return false
    }
  })()
  return webGpu
}

/** Whether Transformers.js's browser cache holds ONNX weights of `model`. A server's file cache isn't read. */
async function inCache(model: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined" || !(await caches.has("transformers-cache"))) return false
    const keys = await (await caches.open("transformers-cache")).keys()
    return keys.some(({ url }) => url.includes(`/${model}/`) && /\.onnx(_data(_\d+)?)?$/.test(url))
  } catch {
    return false
  }
}

/** The page's handler: the package's own worker, or on a server this process. */
let own: Client | undefined

/** The callers' own workers' handlers: one a worker. */
const given = new WeakMap<Worker, Client>()

/**
 * The client of the handler an adapter's model runs in: its own worker's
 * (shared by every adapter given that worker), else the package's.
 */
export function clientFor(worker?: Worker): Client {
  if (!worker) return (own ??= onServer() ? createClient(serverHandler, false) : createClient(ownWorker, true))
  let client = given.get(worker)
  if (!client) given.set(worker, (client = createClient(givenWorker<WorkerRequest, WorkerReply>(worker), false)))
  return client
}
