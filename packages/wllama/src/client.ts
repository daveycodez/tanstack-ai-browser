/**
 * The page's side of wllama: llama.cpp compiled to WebAssembly, which runs
 * in wllama's own Web Worker. One model at a time: loading another frees
 * the previous one. wllama downloads models to the Origin Private File
 * System once, and loads them from there afterwards.
 *
 * wllama is the official `@wllama/wllama` package, unmodified, used through
 * its public API. Its package has no `exports` and its `main` names a file
 * it doesn't ship, so its built ES module is imported by path.
 */
import { LoggerWithoutDebug, ModelManager, Wllama } from "@wllama/wllama/esm/index.js"
import type { WllamaCompat } from "@wllama/wllama/esm/index.js"

import { modelUrl } from "./catalog.js"
import type { WllamaChatModel } from "./catalog.js"

/**
 * Where a model stands in this browser, with the Prompt API's values
 * (`LanguageModel.availability()`).
 */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

/** What a model loads with. A load with other settings loads the model again. */
export type LoadSettings = {
  /** Most tokens a chat may hold; undefined for the model's training context. */
  contextLength?: number
  /** Where wllama's WebAssembly file is served (`WLLAMA_WASM_URL` by default). */
  wasmUrl?: string
  /** wllama's compat build, for browsers without JSPI (Safari), passed to `Wllama.setCompat`. */
  compat?: WllamaCompat
  /** CPU threads; wllama's default otherwise. */
  threads?: number
  /** `false` to run on the CPU only. */
  gpu?: boolean
  /** wllama's and llama.cpp's logs, in the console. */
  debug?: boolean
}

/** The version of `@wllama/wllama` this package depends on. */
export const WLLAMA_VERSION = "3.8.1"

/**
 * wllama's WebAssembly file on jsDelivr, for `WLLAMA_VERSION`: the URL of
 * wllama's own `WasmFromCDN`, which its 3.8.1 package doesn't ship. It has
 * to match wllama's JavaScript, so it's the same version.
 */
export const WLLAMA_WASM_URL = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/src/wasm/wllama.wasm`

/** The model wllama holds (or is loading). */
let loaded: {
  model: WllamaChatModel
  key: string
  wllama: Wllama
  promise: Promise<Wllama>
  ready: boolean
  /** Stops its download. */
  abort: AbortController
  /** The waiting callers' progress callbacks. */
  listeners: Set<DownloadProgressCallback>
} | null = null

/** Models whose file is downloading in this page. */
const downloading = new Set<WllamaChatModel>()

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

/** Frees the loaded model, stopping its download. Given a model, only if it's the one loaded. */
export async function unloadModel(model?: WllamaChatModel) {
  const current = loaded
  if (!current || (model !== undefined && current.model !== model)) return
  loaded = null
  downloading.delete(current.model)
  current.abort.abort()
  await current.wllama.exit().catch(() => undefined)
}

/**
 * The model, loaded with `settings` (downloading it the first time), in
 * place of any other. `onDownloadProgress` hears the download, 0 to 1,
 * then 1 once the model is ready. Aborting `signal` stops this caller's
 * wait; `unloadModel` stops the load.
 */
export async function loadModel(
  model: WllamaChatModel,
  settings: LoadSettings,
  { onDownloadProgress, signal }: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
): Promise<Wllama> {
  signal?.throwIfAborted()
  const key = JSON.stringify(settings)
  if (loaded?.model !== model || loaded.key !== key) {
    await unloadModel()
    const wllama = new Wllama(
      { default: settings.wasmUrl ?? WLLAMA_WASM_URL },
      { logger: settings.debug ? console : LoggerWithoutDebug, suppressNativeLog: !settings.debug }
    )
    if (settings.compat) wllama.setCompat(settings.compat)
    const abort = new AbortController()
    // This caller's callback first: wllama may report progress at once.
    const listeners = new Set<DownloadProgressCallback>(onDownloadProgress ? [onDownloadProgress] : [])
    const promise = wllama
      .loadModelFromUrl(modelUrl(model), {
        signal: abort.signal,
        progressCallback: ({ loaded: bytes, total }) => {
          // A model in storage reports its whole size once, without downloading.
          if (!total || bytes >= total) return
          downloading.add(model)
          for (const listener of listeners) listener(bytes / total)
        },
        // 0: llama.cpp's "the model's training context" (wllama's default is 1,024).
        n_ctx: settings.contextLength ?? 0,
        // The whole context in sliding-window layers' cache (LFM3's), so a
        // follow-up reuses what was read before.
        swa_full: true,
        ...(settings.gpu === false && { n_gpu_layers: 0 }),
        ...(settings.threads && { n_threads: settings.threads })
      })
      .then(() => wllama)
      .finally(() => downloading.delete(model))
    const current = { model, key, wllama, promise, ready: false, abort, listeners }
    loaded = current
    promise.then(
      () => {
        current.ready = true
      },
      () => {
        if (loaded === current) void unloadModel(model)
      }
    )
  }
  const current = loaded
  if (onDownloadProgress) current.listeners.add(onDownloadProgress)
  try {
    const wllama = await abortable(current.promise, signal)
    onDownloadProgress?.(1)
    return wllama
  } finally {
    if (onDownloadProgress) current.listeners.delete(onDownloadProgress)
  }
}

/** wllama's model storage, read from the page (the Origin Private File System). */
let storage: ModelManager | undefined

/**
 * Where `model` stands in this browser, with the Prompt API's values:
 * "unavailable" where wllama can't run (no WebAssembly, Web Worker or
 * Origin Private File System), "downloading" while this page downloads it,
 * "available" when it's loaded or its file is in wllama's storage, else
 * "downloadable". It reads storage only.
 */
export async function availability(model: WllamaChatModel): Promise<Availability> {
  const runs =
    typeof WebAssembly !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  if (!runs) return "unavailable"
  if (downloading.has(model)) return "downloading"
  if (loaded?.model === model && loaded.ready) return "available"
  try {
    storage ??= new ModelManager()
    const saved = await storage.getModels()
    return saved.some((m) => m.url === modelUrl(model)) ? "available" : "downloadable"
  } catch {
    return "downloadable"
  }
}
