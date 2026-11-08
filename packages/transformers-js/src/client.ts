/**
 * The page's side of the Transformers.js worker (worker.ts), which loads and
 * runs the model off the main thread so the page stays smooth. One worker,
 * and one model in it at a time: loading another frees the previous one.
 */
import { claimMemory, releaseMemory, touchMemory } from "./model-memory.js"
import { modelMeta, runsWithoutWebGpu } from "./catalog.js"
import type {
  ChatTurn,
  RunTimings,
  WorkerSampling,
  ToolSpec,
  WeightsDtype,
  WorkerRequest,
  WorkerResponse
} from "./protocol.js"

/**
 * Where a model stands, with the Prompt API's values
 * (`LanguageModel.availability()`): "unavailable" (it can't run here),
 * "downloadable" (it can: loading it downloads it, or reads it from the
 * cache), "downloading" or "available" (loaded and ready in this page).
 * This package's `availability()` never says "downloading": a load's
 * progress comes from `createSessionWithProgress`'s callback.
 */
export type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

/** Listeners for each running generation, by request id. */
type Generation = {
  onToken: (text: string) => void
  onEnd: (error?: string, stats?: RunTimings) => void
}
const generations = new Map<string, Generation>()

type Pending = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  /** Its callers' download progress callbacks. */
  listeners: Set<DownloadProgressCallback>
  /** Resolved: the model is ready. */
  ready: boolean
}
/**
 * The model the worker holds (or is loading), as loaded: its weights and
 * context, and the load (its id in the worker's replies, and its promise).
 */
let loaded: {
  id: number
  modelId: string
  dtype: WeightsDtype
  contextLength: number | undefined
  load: Pending
} | null = null
let loads = 0

let worker: Worker | null = null
let debug = false

/** This runtime's name in the shared memory registry. */
const OWNER = "transformers-js"

/** Models never unloaded to make room for another runtime's (see setKeepLoaded). */
const keepLoaded = new Set<string>()

/**
 * Keeps `model` loaded when another runtime (WebGL, wllama) loads a model
 * past the memory budget; by default the least recently used goes.
 */
export function setKeepLoaded(model: string, keep: boolean) {
  if (keep) keepLoaded.add(model)
  else keepLoaded.delete(model)
}

/**
 * Turns on the worker's diagnostics (memory and cache logs, error stacks in
 * the console). Takes effect if called before the worker starts.
 */
export function setDebug(on: boolean) {
  debug = on
}

function handleMessage({ data }: MessageEvent<WorkerResponse>) {
  // Replies about a load a later one superseded are stale.
  const current =
    (data.type === "progress" || data.type === "ready" || data.type === "load-error") &&
    loaded?.id === data.loadId
      ? loaded
      : null
  if (data.type === "progress") {
    if (!current || data.cached) return
    keepDownloads()
    report(current.load, data.progress)
  } else if (data.type === "claim") {
    const { modelId, bytes } = data
    void claimMemory({
      owner: OWNER,
      model: modelId,
      bytes,
      keepLoaded: keepLoaded.has(modelId),
      unload: unloadModel
    }).then(() => post({ type: "claimed" }))
  } else if (data.type === "ready") {
    if (!current) return
    current.load.ready = true
    report(current.load, 1)
    current.load.resolve()
  } else if (data.type === "load-error") {
    if (!current) return
    current.load.reject(new Error(data.message))
    loaded = null
    releaseMemory(OWNER)
  } else if (data.type === "token") {
    generations.get(data.id)?.onToken(data.text)
  } else if (data.type === "log") {
    // A worker's own console output doesn't reach a dev server's terminal.
    console.info(data.text)
  } else {
    const generation = generations.get(data.id)
    generations.delete(data.id)
    if (data.type === "error") generation?.onEnd(data.message)
    else generation?.onEnd(undefined, data.stats)
  }
}

/** Calls a load's progress callbacks; a callback that throws doesn't stop the load. */
function report(load: Pending, progress: number) {
  for (const listener of load.listeners) call(listener, progress)
}

function call(listener: DownloadProgressCallback, progress: number) {
  try {
    listener(progress)
  } catch (error) {
    console.error(error)
  }
}


function post(message: WorkerRequest) {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
      // The worker reads its name to turn on diagnostics before any message.
      name: debug ? "transformers-js:debug" : "transformers-js"
    })
    worker.onmessage = handleMessage
  }
  worker.postMessage(message)
}

/**
 * Asks the browser to keep this site's storage, so a downloaded model isn't
 * deleted to free space or, in Safari, after 7 days without a visit (which
 * means downloading it again). Browsers may say no; it's only a request.
 * Only pages can ask, not workers. Called when a download starts, not for
 * cached loads. Skipped in Firefox, which shows a permission prompt for it;
 * there a model is still kept across reloads, unless the disk runs low.
 */
let askedToKeep = false
function keepDownloads() {
  if (askedToKeep || typeof navigator === "undefined") return
  askedToKeep = true
  if (/firefox/i.test(navigator.userAgent)) return
  navigator.storage
    ?.persist?.()
    .then((kept) => {
      if (debug) console.info(`[download] storage kept: ${kept}`)
    })
    .catch(() => undefined)
}

let webGpu: Promise<boolean> | undefined

/**
 * Whether models here run on WebGPU: the browser has it and gives a GPU
 * adapter. Where it doesn't, they run on the CPU through WebAssembly, which
 * needs a model with q4 weights (see `availability`). The worker makes the
 * same check when it loads a model.
 */
function hasWebGpu(): Promise<boolean> {
  webGpu ??= (async () => {
    const nav =
      typeof navigator === "undefined"
        ? undefined
        : (navigator as Navigator & {
            gpu?: { requestAdapter: () => Promise<unknown> }
          })
    if (!nav?.gpu) return false
    try {
      return (await nav.gpu.requestAdapter()) !== null
    } catch {
      return false
    }
  })()
  return webGpu
}

/**
 * Whether Transformers.js can run `model` in this browser: on WebGPU, or
 * without it on the CPU through WebAssembly, which needs a model with q4
 * weights (a listed model's `cpu`, pinned to a revision or not; any other
 * Hugging Face id is taken to have them, and loading says if its repo
 * doesn't). Either way the model runs in a Web Worker on ONNX Runtime's
 * WebAssembly, so it needs both (not on a server).
 */
async function canRun(model: string): Promise<boolean> {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return false
  return (await hasWebGpu()) || runsWithoutWebGpu(model)
}

/**
 * Where `model` stands, as the Prompt API's `LanguageModel.availability()`
 * says it: "unavailable" where it can't run (no Web Worker or WebAssembly,
 * as on a server, or no WebGPU and no CPU weights), "available" when it's
 * loaded and ready in this page (for `dtype`), else "downloadable", while a
 * load is in progress and when its files are cached too. No storage reads,
 * no worker, no Transformers.js, no network: only the browser's WebGPU
 * adapter request.
 */
export async function availability(
  model: string,
  options: { dtype?: WeightsDtype } = {}
): Promise<Availability> {
  if (!(await canRun(model))) return "unavailable"
  const dtype = options.dtype ?? modelMeta(model)?.dtype ?? "q4f16"
  return loaded?.modelId === model && loaded.dtype === dtype && loaded.load.ready
    ? "available"
    : "downloadable"
}

/**
 * Loads a model (downloading it the first time), replacing any other: a
 * listed model or any Hugging Face id: "owner/repo" for its latest version
 * (main), "owner/repo@commit" for that one. `dtype` is the weights to load
 * (a listed model's own by default, else "q4f16"); without WebGPU the worker
 * loads its q4 weights on the CPU instead. Chats may hold up to
 * `contextLength` tokens: the model's own context window by default.
 */
export function loadModel(
  model: string,
  options: {
    dtype?: WeightsDtype
    contextLength?: number
    /**
     * The download's progress, 0 to 1, while the model's files download;
     * then 1 once it's ready (at once if it already is).
     */
    onDownloadProgress?: DownloadProgressCallback
  } = {}
): Promise<void> {
  const { contextLength, onDownloadProgress } = options
  const dtype = options.dtype ?? modelMeta(model)?.dtype ?? "q4f16"
  const modelId = model
  if (
    loaded?.modelId === modelId &&
    loaded.dtype === dtype &&
    loaded.contextLength === contextLength
  ) {
    // A new callback hears 1 at once if the model is ready already.
    if (onDownloadProgress && !loaded.load.listeners.has(onDownloadProgress)) {
      loaded.load.listeners.add(onDownloadProgress)
      if (loaded.load.ready) call(onDownloadProgress, 1)
    }
    return loaded.load.promise
  }
  if (loaded) {
    // The worker frees the previous model before loading this one.
    loaded.load.reject(new Error("Switched to another model."))
  }
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => undefined)
  const id = ++loads
  const listeners = new Set<DownloadProgressCallback>(
    onDownloadProgress ? [onDownloadProgress] : []
  )
  loaded = {
    id,
    modelId,
    dtype,
    contextLength,
    load: { promise, resolve, reject, listeners, ready: false }
  }
  try {
    post({
      type: "load",
      loadId: id,
      modelId,
      dtype,
      ...(contextLength !== undefined && { contextLength })
    })
  } catch (error) {
    // No worker here (a server, say): the load fails at once.
    const message = error instanceof Error ? error.message : String(error)
    loaded = null
    reject(new Error(message))
  }
  return promise
}

/**
 * Frees the loaded model, all its GPU and WebAssembly memory with it, by
 * ending the worker (the next load starts a new one). Given a model, only if
 * it's the one loaded (or loading). Another runtime loading a model past the
 * memory budget calls it too.
 */
export async function unloadModel(model?: string): Promise<void> {
  if (model !== undefined && loaded?.modelId !== model) return
  worker?.terminate()
  worker = null
  releaseMemory(OWNER)
  if (loaded) {
    loaded.load.reject(new Error("The model was unloaded."))
    loaded = null
  }
  for (const [id, generation] of generations) {
    generations.delete(id)
    generation.onEnd("The model was unloaded.")
  }
}

/** What a finished generation left: its error, if it failed, and its counts. */
export type GenerationEnd = { failure?: string; stats?: RunTimings }

/**
 * Runs one generation with the loaded model, yielding its text as it comes
 * (thinking and tool-call markup included, as the model writes them).
 */
export async function* generate(request: {
  id: string
  chat: Array<ChatTurn>
  tools: Array<ToolSpec>
  thinking?: boolean
  thinkingBudgetTokens?: number
  outputSchema?: object
  cachePrompt?: boolean
  sampling: WorkerSampling
  maxTokens?: number
  contextLength?: number
  thinkingOpen: string
  thinkingClose: string
  signal?: AbortSignal
}): AsyncGenerator<string, GenerationEnd> {
  const { id, signal } = request
  // Bridge the worker's messages to this async generator.
  const queue: Array<string> = []
  let wake: (() => void) | null = null
  let finished = false
  let end: GenerationEnd = {}
  generations.set(id, {
    onToken: (text) => {
      queue.push(text)
      wake?.()
    },
    onEnd: (failure, stats) => {
      end = { failure, stats }
      finished = true
      wake?.()
    }
  })
  const onAbort = () => post({ type: "stop", id })
  signal?.addEventListener("abort", onAbort)
  touchMemory(OWNER)
  post({
    type: "generate",
    id,
    chat: request.chat,
    tools: request.tools,
    ...(request.thinking !== undefined && { thinking: request.thinking }),
    sampling: request.sampling,
    ...(request.thinkingBudgetTokens !== undefined && { thinkingBudgetTokens: request.thinkingBudgetTokens }),
    ...(request.outputSchema !== undefined && { outputSchema: request.outputSchema }),
    ...(request.cachePrompt !== undefined && { cachePrompt: request.cachePrompt }),
    ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
    ...(request.contextLength !== undefined && {
      contextLength: request.contextLength
    }),
    thinkingOpen: request.thinkingOpen,
    thinkingClose: request.thinkingClose
  })
  try {
    while (!finished || queue.length > 0) {
      const text = queue.shift()
      if (text !== undefined) {
        yield text
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = null
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (!finished) {
      generations.delete(id)
      post({ type: "stop", id })
    }
  }
  return end
}
