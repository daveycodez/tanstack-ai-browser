/**
 * The page's side of the embedder: MediaPipe's TextEmbedder runs in a Web
 * Worker of its own (worker.ts). One embedder at a time: loading another
 * model, or the same with other load options, ends the previous worker.
 */
import { MEDIAPIPE_MODEL_META } from "./model-meta.js"
import type { MediaPipeEmbeddingModel } from "./model-meta.js"
import type { MediaPipeEmbeddingConfig } from "./options.js"
import type { WorkerRequest, WorkerResponse } from "./protocol.js"
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

/** An embedder's worker, its load, and the requests waiting on it. */
type Loaded = {
  model: MediaPipeEmbeddingModel
  /** The load options it was loaded with, as a key. */
  key: string
  worker: Worker
  promise: Promise<void>
  fail: (error: Error) => void
  pending: Map<number, Pending>
}

let loaded: Loaded | null = null

let nextId = 0

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** A rejected promise that's fine to leave unawaited. */
function rejected(error: unknown) {
  const promise = Promise.reject(error instanceof Error ? error : new Error(errorText(error)))
  promise.catch(() => undefined)
  return promise
}

/** What the worker loads, for a model and its load options. */
function loadRequest(model: MediaPipeEmbeddingModel, config: MediaPipeEmbeddingConfig) {
  const meta = MEDIAPIPE_MODEL_META[model] as
    | (typeof MEDIAPIPE_MODEL_META)[MediaPipeEmbeddingModel]
    | undefined
  if (!meta) {
    throw new Error(
      `Unknown MediaPipe embedding model "${model}": the models are ${Object.keys(MEDIAPIPE_MODEL_META).join(", ")}.`
    )
  }
  return {
    type: "load",
    wasmPath: config.wasmPath ?? MEDIAPIPE_WASM_URL,
    modelUrl: config.modelAssetPath ?? meta.file,
    ...(config.delegate && { delegate: config.delegate })
  } satisfies WorkerRequest
}

/**
 * Frees the loaded embedder (ending its worker, and its download if it's
 * downloading). Given a model, only if it's the one loaded (or loading).
 */
export async function unloadModel(model?: MediaPipeEmbeddingModel) {
  if (model !== undefined && loaded?.model !== model) return
  const current = loaded
  if (!current) return
  loaded = null
  modelStatus(current.model).set({ state: "idle" })
  current.worker.terminate()
  current.fail(new Error("The model was unloaded."))
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
function load(model: MediaPipeEmbeddingModel, config: MediaPipeEmbeddingConfig): Loaded {
  const request = loadRequest(model, config)
  const key = JSON.stringify(request)
  if (loaded?.model === model && loaded.key === key) return loaded
  const status = modelStatus(model)
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    const message = "MediaPipe needs WebAssembly and Web Workers, which this environment doesn't have."
    status.set({ state: "error", message })
    throw new Error(message)
  }
  void unloadModel()
  status.set({ state: "loading", progress: 0, cached: true })

  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: "mediapipe"
  })
  const pending = new Map<number, Pending>()
  let settle!: { resolve: () => void; reject: (error: Error) => void }
  const promise = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject }
  })
  promise.catch(() => undefined)
  const fail = (error: Error) => {
    settle.reject(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const current: Loaded = { model, key, worker, promise, fail, pending }
  loaded = current

  const failLoad = (message: string) => {
    if (loaded !== current) return
    loaded = null
    worker.terminate()
    status.set({ state: "error", message })
    fail(new Error(message))
  }
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    if (loaded !== current) return
    if (data.type === "progress") {
      const { cached, loadedBytes, totalBytes } = data
      status.set({
        state: "loading",
        progress: totalBytes ? Math.min(loadedBytes / totalBytes, 1) : 0,
        cached,
        ...(!cached && { loadedBytes, ...(totalBytes && { totalBytes }) })
      })
    } else if (data.type === "ready") {
      status.set({ state: "ready" })
      settle.resolve()
    } else if (data.type === "load-error") {
      failLoad(data.message)
    } else {
      const request = pending.get(data.id)
      pending.delete(data.id)
      if (data.type === "embedded") request?.resolve(data.vectors)
      else request?.reject(new Error(data.message))
    }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    failLoad(`MediaPipe's worker failed: ${event.message || "it couldn't start"}.`)
  }
  worker.postMessage(request)
  return current
}

/**
 * One vector per text from `model`, loading it first (with `config`). The
 * embedder options apply to this request.
 */
export async function embedTexts(
  model: MediaPipeEmbeddingModel,
  config: MediaPipeEmbeddingConfig,
  texts: Array<string>,
  options: { l2Normalize: boolean; quantize: boolean }
): Promise<Array<Float32Array>> {
  const current = load(model, config)
  await current.promise
  if (loaded !== current) throw new Error("The model was unloaded.")
  const id = nextId++
  return new Promise((resolve, reject) => {
    current.pending.set(id, { resolve, reject })
    current.worker.postMessage({ type: "embed", id, texts, ...options } satisfies WorkerRequest)
  })
}
