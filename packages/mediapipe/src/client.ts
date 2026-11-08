/**
 * The page's side of the embedder: MediaPipe's TextEmbedder runs in a Web
 * Worker of its own (worker.ts). One embedder at a time: loading another
 * model, or the same with other load options, replaces the worker, once the
 * requests already on the previous one are done.
 */
import { MEDIAPIPE_MODEL_META } from "./model-meta.js"
import type { MediaPipeEmbeddingModel } from "./model-meta.js"
import type { MediaPipeEmbeddingConfig } from "./options.js"
import type { LoadRequest, WorkerRequest, WorkerResponse } from "./protocol.js"
import { createStore } from "./store.js"
import type { Store } from "./store.js"
import { MEDIAPIPE_WASM_URL } from "./version.js"

export type ModelStatus =
  | { state: "idle" }
  | {
      state: "loading"
      /** 0-1 across the model's file. */
      progress: number
      /** True when the file comes from the browser's storage, not the network. */
      cached: boolean
      /** Bytes downloaded so far, while downloading. */
      loadedBytes?: number
      /** Bytes of the model's file, while downloading. */
      totalBytes?: number
    }
  | { state: "ready" }
  | { state: "error"; message: string }

const statuses = new Map<string, Store<ModelStatus>>()

/** Loading status of a model, by its name. */
export function modelStatus(model: MediaPipeEmbeddingModel): Store<ModelStatus> {
  let status = statuses.get(model)
  if (!status) {
    status = createStore<ModelStatus>({ state: "idle" })
    statuses.set(model, status)
  }
  return status
}

type Pending = {
  resolve: (vectors: Array<Float32Array>) => void
  reject: (error: Error) => void
}

/** An embedder's worker, its load, and the requests using it. */
type Embedder = {
  model: MediaPipeEmbeddingModel
  /** Its load request, as a key: the same key shares the worker. */
  key: string
  worker: Worker
  promise: Promise<void>
  settle: { resolve: () => void; reject: (error: Error) => void }
  pending: Map<number, Pending>
  /** embed calls using it, from their load to their reply. */
  users: number
  /** Replaced by another load: ended once its users are done. */
  retired: boolean
  /** Ended: failed, unloaded, or retired and done. */
  ended: boolean
}

let loaded: Embedder | null = null

let nextId = 0

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(errorText(error))

/** A rejected promise that's fine to leave unawaited. */
function rejected(error: unknown) {
  const promise = Promise.reject(toError(error))
  promise.catch(() => undefined)
  return promise
}

/** The page's URL, which relative paths are relative to. */
function pageUrl(): string | undefined {
  if (typeof document !== "undefined" && document.baseURI) return document.baseURI
  return (globalThis as { location?: { href?: string } }).location?.href
}

/**
 * What the worker loads, for a model and its load options, with their
 * effective values, so equivalent options share a worker: paths resolved
 * against `base` (the page; the worker's own URL is elsewhere), and
 * MediaPipe's default delegate, the CPU.
 */
export function loadRequest(
  model: MediaPipeEmbeddingModel,
  config: MediaPipeEmbeddingConfig,
  base: string | undefined = pageUrl()
): LoadRequest {
  const meta = MEDIAPIPE_MODEL_META[model] as
    | (typeof MEDIAPIPE_MODEL_META)[MediaPipeEmbeddingModel]
    | undefined
  if (!meta) {
    throw new Error(
      `Unknown MediaPipe embedding model "${model}": the models are ${Object.keys(MEDIAPIPE_MODEL_META).join(", ")}.`
    )
  }
  const resolve = (path: string) => (base ? new URL(path, base).href : path)
  return {
    type: "load",
    wasmPath: resolve(config.wasmPath ?? MEDIAPIPE_WASM_URL),
    modelUrl: resolve(config.modelAssetPath ?? meta.file),
    delegate: config.delegate ?? "CPU",
    cacheWasm: config.cacheWasm ?? true
  }
}

/** Ends an embedder's worker; its load and requests fail with `error`. */
function end(embedder: Embedder, error: Error) {
  if (embedder.ended) return
  embedder.ended = true
  embedder.worker.terminate()
  embedder.settle.reject(error)
  for (const request of embedder.pending.values()) request.reject(error)
  embedder.pending.clear()
}

/** Ends a replaced embedder once no request is using it. */
function endIfUnused(embedder: Embedder) {
  if (embedder.retired && embedder.users === 0) {
    end(embedder, new Error("Another MediaPipe model load replaced this one."))
  }
}

/**
 * Frees the loaded embedder (ending its worker, and its download if it's
 * downloading). Given a model, only if it's the one loaded (or loading).
 * Requests waiting on it fail.
 */
export async function unloadModel(model?: MediaPipeEmbeddingModel) {
  if (model !== undefined && loaded?.model !== model) return
  const current = loaded
  if (!current) return
  loaded = null
  modelStatus(current.model).set({ state: "idle" })
  end(current, new Error("The model was unloaded."))
}

/**
 * Loads a model (downloading it the first time), replacing any other. The
 * promise settles when it's ready to embed; a failure is in
 * `modelStatus(model)` too, so it's fine to leave unawaited.
 */
export function loadModel(
  model: MediaPipeEmbeddingModel,
  config: MediaPipeEmbeddingConfig = {}
): Promise<void> {
  try {
    return load(model, config).promise
  } catch (error) {
    return rejected(error)
  }
}

/** The embedder for `model` with `config`, loaded or loading. Throws if it can't start. */
function load(model: MediaPipeEmbeddingModel, config: MediaPipeEmbeddingConfig): Embedder {
  const request = loadRequest(model, config)
  const key = JSON.stringify(request)
  if (loaded?.model === model && loaded.key === key) return loaded
  const status = modelStatus(model)
  let worker: Worker
  try {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
      throw new Error(
        "MediaPipe needs WebAssembly and Web Workers, which this environment doesn't have."
      )
    }
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
      name: "mediapipe"
    })
  } catch (error) {
    // (A page's policy can refuse the worker.) The embedder loaded before,
    // if any, stays.
    status.set({ state: "error", message: errorText(error) })
    throw toError(error)
  }

  // The previous embedder ends once the requests using it are done.
  const previous = loaded
  if (previous) {
    if (previous.model !== model) modelStatus(previous.model).set({ state: "idle" })
    previous.retired = true
    endIfUnused(previous)
  }
  status.set({ state: "loading", progress: 0, cached: true })

  let settle!: Embedder["settle"]
  const promise = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject }
  })
  promise.catch(() => undefined)
  const embedder: Embedder = {
    model,
    key,
    worker,
    promise,
    settle,
    pending: new Map(),
    users: 0,
    retired: false,
    ended: false
  }
  loaded = embedder

  const failLoad = (message: string) => {
    end(embedder, new Error(message))
    if (loaded !== embedder) return
    loaded = null
    status.set({ state: "error", message })
  }
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    if (data.type === "progress") {
      if (loaded !== embedder) return
      const { cached, loadedBytes, totalBytes } = data
      status.set({
        state: "loading",
        progress: totalBytes ? Math.min(loadedBytes / totalBytes, 1) : 0,
        cached,
        ...(!cached && { loadedBytes, ...(totalBytes && { totalBytes }) })
      })
    } else if (data.type === "ready") {
      if (loaded === embedder) status.set({ state: "ready" })
      settle.resolve()
    } else if (data.type === "load-error") {
      failLoad(data.message)
    } else {
      const pending = embedder.pending.get(data.id)
      embedder.pending.delete(data.id)
      if (data.type === "embedded") pending?.resolve(data.vectors)
      else pending?.reject(new Error(data.message))
    }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    failLoad(`MediaPipe's worker failed: ${event.message || "it couldn't start"}.`)
  }
  worker.postMessage(request satisfies WorkerRequest)
  return embedder
}

/**
 * One vector per text from `model`, loading it first (with `config`). The
 * embedder options apply to this request. A load with other options in the
 * meantime doesn't cut it off: its worker is kept until it's done.
 */
export async function embedTexts(
  model: MediaPipeEmbeddingModel,
  config: MediaPipeEmbeddingConfig,
  texts: Array<string>,
  options: { l2Normalize: boolean; quantize: boolean }
): Promise<Array<Float32Array>> {
  const embedder = load(model, config)
  embedder.users++
  try {
    await embedder.promise
    const id = nextId++
    return await new Promise<Array<Float32Array>>((resolve, reject) => {
      if (embedder.ended) {
        reject(new Error("The model was unloaded."))
        return
      }
      embedder.pending.set(id, { resolve, reject })
      embedder.worker.postMessage({
        type: "embed",
        id,
        texts,
        ...options
      } satisfies WorkerRequest)
    })
  } finally {
    embedder.users--
    endIfUnused(embedder)
  }
}
