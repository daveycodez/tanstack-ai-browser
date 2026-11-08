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
import { MEDIAPIPE_WASM_URL } from "./version.js"
import { CACHE_NAME } from "./download.js"
import { abortError, callProgress, LoadWaiters } from "./shared-load.js"

/**
 * Where a model stands in this browser, with the Prompt API's values
 * (`LanguageModel.availability()`): "unavailable" (it can't run here),
 * "downloadable" (it can, once downloaded), "downloading" (a download of it
 * is in progress in this page) or "available" (on the device: no download
 * needed).
 */
export type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

const call = callProgress

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
  /** The callers waiting on its load, with their download progress callbacks. */
  waiters: LoadWaiters
  /** The model's file is downloading (not read from the cache). */
  downloading: boolean
  /** Loaded: ready to embed. */
  ready: boolean
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
  embedder.downloading = false
  embedder.waiters.settle()
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
  end(current, new Error("The model was unloaded."))
}

/**
 * Loads a model (downloading it the first time), replacing any other. The
 * promise settles when it's ready to embed; it's fine to leave unawaited.
 * `onDownloadProgress` hears the model file's download, 0 to 1, then 1
 * once it's ready (at once if it already is).
 */
export function loadModel(
  model: MediaPipeEmbeddingModel,
  config: MediaPipeEmbeddingConfig = {},
  onDownloadProgress?: DownloadProgressCallback,
  /**
   * Stops this caller's wait: it rejects at once with an AbortError and
   * hears no more progress. If no other caller (another load, or an embed
   * call) is waiting on the load, the worker is ended, its download with it.
   */
  signal?: AbortSignal
): Promise<void> {
  // An aborted caller starts nothing.
  if (signal?.aborted) return rejected(abortError())
  try {
    return waitFor(load(model, config), onDownloadProgress, signal, true)
  } catch (error) {
    return rejected(error)
  }
}

/**
 * `embedder`'s load for one more caller: every caller hears 1 at once if
 * it's ready already (but an embed call's own wait), and a caller whose
 * `signal` aborts stops waiting (see `LoadWaiters`).
 */
function waitFor(
  embedder: Embedder,
  onDownloadProgress: DownloadProgressCallback | undefined,
  signal: AbortSignal | undefined,
  reportReady: boolean
): Promise<void> {
  if (!embedder.ready || signal?.aborted) {
    return embedder.waiters.wait(embedder.promise, { onDownloadProgress, signal })
  }
  if (onDownloadProgress && reportReady) call(onDownloadProgress, 1)
  return embedder.promise
}

/** Whether MediaPipe can run here (see `availability`). */
function canRun(): boolean {
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") return false
  try {
    return WebAssembly.validate(SIMD_MODULE)
  } catch {
    return false
  }
}

/**
 * A WebAssembly module with one SIMD instruction: MediaPipe's WebAssembly
 * is built with SIMD and has no build without it.
 */
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
  253, 15, 253, 98, 11
])

/**
 * Where `model` (loaded with `config`) stands in this browser, as the
 * Prompt API's `LanguageModel.availability()` says it: "unavailable" where
 * MediaPipe can't run (its TextEmbedder needs WebAssembly with SIMD in a
 * module Web Worker; not on a server) or the model isn't one it lists,
 * "downloading" while this page downloads its file, "available" when it's
 * loaded or its file (and, with `cacheWasm`, MediaPipe's WebAssembly) is in
 * Cache Storage, else "downloadable". It reads Cache Storage only: no
 * worker, no network.
 */
export async function availability(
  model: MediaPipeEmbeddingModel,
  config: MediaPipeEmbeddingConfig = {}
): Promise<Availability> {
  if (!canRun()) return "unavailable"
  let request: LoadRequest
  try {
    request = loadRequest(model, config)
  } catch {
    return "unavailable"
  }
  const key = JSON.stringify(request)
  const current = () => (loaded?.model === model && loaded.key === key ? loaded : null)
  if (current()?.downloading) return "downloading"
  if (current()?.ready) return "available"
  if (typeof caches === "undefined") return "downloadable"
  try {
    const cache = await caches.open(CACHE_NAME)
    // MediaPipe's names for its files, as its FilesetResolver gives them
    // for a module worker.
    const wasm = `${request.wasmPath.replace(/\/$/, "")}/text_wasm_module_internal`
    const urls = request.cacheWasm
      ? [request.modelUrl, `${wasm}.js`, `${wasm}.wasm`]
      : [request.modelUrl]
    const hits = await Promise.all(urls.map((url) => cache.match(url)))
    if (current()?.downloading) return "downloading"
    return hits.every(Boolean) ? "available" : "downloadable"
  } catch {
    return "downloadable"
  }
}

/** The embedder for `model` with `config`, loaded or loading. Throws if it can't start. */
function load(model: MediaPipeEmbeddingModel, config: MediaPipeEmbeddingConfig): Embedder {
  const request = loadRequest(model, config)
  const key = JSON.stringify(request)
  if (loaded?.model === model && loaded.key === key) return loaded
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
    throw toError(error)
  }

  // The previous embedder ends once the requests using it are done.
  const previous = loaded
  if (previous) {
    previous.downloading = false
    previous.retired = true
    endIfUnused(previous)
  }
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
    ended: false,
    // The last caller waiting gave up: end the worker, its download with it.
    waiters: new LoadWaiters(() => {
      if (loaded !== embedder) return
      loaded = null
      end(embedder, abortError())
    }),
    downloading: false,
    ready: false
  }
  loaded = embedder
  const report = (progress: number) => embedder.waiters.report(progress)

  const failLoad = (message: string) => {
    end(embedder, new Error(message))
    if (loaded !== embedder) return
    loaded = null
  }
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    if (data.type === "progress") {
      if (loaded !== embedder || data.cached) return
      const { loadedBytes, totalBytes } = data
      embedder.downloading = true
      report(totalBytes ? Math.min(loadedBytes / totalBytes, 1) : 0)
    } else if (data.type === "ready") {
      embedder.downloading = false
      embedder.ready = true
      if (loaded === embedder) report(1)
      embedder.waiters.settle()
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
  options: { l2Normalize: boolean; quantize: boolean },
  onDownloadProgress?: DownloadProgressCallback
): Promise<Array<Float32Array>> {
  const embedder = load(model, config)
  embedder.users++
  try {
    await waitFor(embedder, onDownloadProgress, undefined, false)
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
