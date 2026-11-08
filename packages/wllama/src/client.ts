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
import type {
  ChatCompletionChunk,
  ChatCompletionParams,
  ChatCompletionResponse,
  WllamaCompat,
  WllamaLogger
} from "@wllama/wllama/esm/index.js"

import { claimMemory, releaseMemory, touchMemory } from "./model-memory.js"
import { modelMeta, modelUrl } from "./catalog.js"
import { callProgress, LoadWaiters } from "./shared-load.js"
import type { WllamaChatModel } from "./catalog.js"

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

/** Models whose file is downloading in this page. */
const downloading = new Set<WllamaChatModel>()

const call = callProgress

/** Options that apply to the runtime, so to every model. */
export type RuntimeOptions = {
  /**
   * Where wllama's WebAssembly file is served. By default, the installed
   * wllama's own file on jsDelivr (`WLLAMA_WASM_URL`), which matches its
   * JavaScript; serve `@wllama/wllama/esm/wasm/wllama.wasm` with the site
   * and pass its URL to host it yourself.
   */
  wasmUrl?: string
  /**
   * Where wllama's compat build is served (the `@wllama/wllama-compat`
   * package's `wasm/wllama.wasm` and `wasm/wllama.js`), for browsers without
   * JSPI or 64-bit WebAssembly memory (Safari). By default, wllama's: the
   * same version on jsDelivr. Passed to `Wllama.setCompat`.
   */
  compat?: WllamaCompat
  /** CPU threads. wllama's default otherwise: half the cores. */
  threads?: number
  /**
   * `false` to run on the CPU only. By default, wllama's: on WebGPU where
   * the browser has it and wllama can drive it, on the CPU elsewhere.
   */
  gpu?: boolean
  /** wllama's and llama.cpp's logs, in the console. */
  debug?: boolean
}

let options: RuntimeOptions = {}

/** Sets runtime options; they apply from the next model load. */
export function configureRuntime(next: RuntimeOptions) {
  options = { ...options, ...next }
}

/** The version of `@wllama/wllama` this package depends on. */
export const WLLAMA_VERSION = "3.8.1"

/**
 * wllama's WebAssembly file on jsDelivr, for `WLLAMA_VERSION`: the URL of
 * wllama's own `WasmFromCDN`, which its 3.8.1 package doesn't ship
 * (`esm/wasm-from-cdn.js` is missing), and the CDN wllama loads its compat
 * build from by default. It has to match wllama's JavaScript, so it's the
 * same version.
 */
export const WLLAMA_WASM_URL = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/src/wasm/wllama.wasm`

/** The WebAssembly file to load (see `RuntimeOptions.wasmUrl`). */
const wasmUrl = () => options.wasmUrl ?? WLLAMA_WASM_URL

/** A new wllama, set up with the runtime options. */
function createWllama(logger: WllamaLogger) {
  const wllama = new Wllama(
    { default: wasmUrl() },
    { logger, suppressNativeLog: !options.debug }
  )
  if (options.compat) wllama.setCompat(options.compat)
  return wllama
}

/** A logger that drops everything. */
const silent: WllamaLogger = {
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

/** The model wllama holds (or is loading), its load, and a way to stop it. */
let loaded: {
  model: WllamaChatModel
  contextLength: number | undefined
  wllama: Wllama
  promise: Promise<Wllama>
  abort: AbortController
  /** The callers waiting on it, with their download progress callbacks. */
  waiters: LoadWaiters
  /** Resolved: the model is ready. */
  ready: boolean
} | null = null

/** This runtime's name in the shared memory registry. */
const OWNER = "wllama"

/** Models never unloaded to make room for another runtime's (see setKeepLoaded). */
const keepLoaded = new Set<WllamaChatModel>()

/**
 * Keeps `model` loaded when another runtime (Transformers.js, WebGL) loads a
 * model past the memory budget; by default the least recently used goes.
 */
export function setKeepLoaded(model: WllamaChatModel, keep: boolean) {
  if (keep) keepLoaded.add(model)
  else keepLoaded.delete(model)
}

/**
 * Frees the loaded model (stopping its download, if it's downloading).
 * Given a model, only if it's the one loaded (or loading). Another runtime
 * loading a model past the memory budget calls it too.
 */
export async function unloadModel(model?: WllamaChatModel) {
  if (model !== undefined && loaded?.model !== model) return
  const current = loaded
  releaseMemory(OWNER)
  if (!current) return
  loaded = null
  downloading.delete(current.model)
  current.abort.abort()
  await current.wllama.exit().catch(() => undefined)
}

/** A file's size from a one-byte range request, or undefined. */
async function remoteSize(url: string, signal: AbortSignal) {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal })
    void res.body?.cancel().catch(() => undefined)
    const total = /\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "")?.[1]
    return total ? Number(total) : undefined
  } catch {
    return undefined
  }
}

/** Each model's contextLength, from its adapter (see setContextLength). */
const contextLengths = new Map<WllamaChatModel, number>()

/**
 * Sets the most tokens a chat with `model` may hold, prompt and reply
 * together; undefined for the model's whole context window (its GGUF's
 * training context). llama.cpp reserves the attention cache for all of it
 * when the model loads, so it applies from the next load.
 */
export function setContextLength(
  model: WllamaChatModel,
  contextLength: number | undefined
) {
  if (contextLength === undefined) contextLengths.delete(model)
  else contextLengths.set(model, contextLength)
}

/** Tokens a chat may hold with the loaded model, as llama.cpp set it up. */
export function loadedContext(wllama: Wllama) {
  const info = wllama.getLoadedContextInfo()
  return info.n_ctx || info.n_ctx_train
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Whether models run on WebGPU here, as wllama sets them up: where the
 * browser has a WebGPU adapter and wllama can drive it (JSPI in its main
 * build, or its compat build, which it uses in Safari), unless
 * `gpu: false`. Elsewhere (Firefox without JSPI, browsers without WebGPU)
 * llama.cpp runs on the CPU in WebAssembly.
 */
export async function runsOnWebGpu(): Promise<boolean> {
  if (options.gpu === false || typeof navigator === "undefined") return false
  if (!("gpu" in navigator)) return false
  if (
    !("Suspending" in WebAssembly) &&
    !createWllama(silent).getWorkerResources().compat
  ) {
    return false
  }
  try {
    return (await navigator.gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

let removedStates = false

/**
 * Deletes the model states earlier versions of this package saved in the
 * Origin Private File System (`wllama-state/`), which nothing reads now.
 */
async function removeSavedStates() {
  if (removedStates) return
  removedStates = true
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry("wllama-state", { recursive: true })
  } catch {
    // Nothing saved, or no storage.
  }
}

/**
 * Memory a model takes, as multiples of its GGUF file's size, while it loads
 * and once loaded. wllama 3.8.1 keeps the whole file in the worker's
 * WebAssembly memory for as long as the model is loaded, and on WebGPU
 * llama.cpp holds the weights on the GPU as well, so a model on WebGPU takes
 * about three times its file. Measured with macOS `footprint` (page and GPU
 * process) in Chrome on an M3 Ultra, at 8,192 tokens, peak and loaded:
 * Qwen3.5 2B (1.28 GB) 3.3-3.4x and 3.0x on WebGPU, 1.8x and 1.25x on the
 * CPU; LFM2.5 1.2B (731 MB) 2.7x and 2.2x on WebGPU, 1.6x and 1.25x on the
 * CPU. The factors are a little above the largest of each.
 */
const MEMORY_FACTORS = {
  gpu: { loading: 3.5, loaded: 3.1 },
  cpu: { loading: 1.9, loaded: 1.35 }
}

/**
 * How long wllama may take to start and load a model once its file is
 * downloaded: a minute, plus a minute per GB of file. wllama 3.8.1 never
 * settles a load whose WebAssembly fails to load or compile (a 404, say);
 * without a deadline it would hold the model slot forever.
 */
const startupDeadline = (fileBytes: number) => 60_000 + (fileBytes / 1e9) * 60_000

/** Rejects with `message` if `promise` hasn't settled after `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

async function startLoad(
  model: WllamaChatModel,
  wllama: Wllama,
  signal: AbortSignal,
  contextLength: number | undefined,
  progress: DownloadProgressCallback
) {
  const url = modelUrl(model)
  const meta = modelMeta(model)
  const factors = MEMORY_FACTORS[(await runsOnWebGpu()) ? "gpu" : "cpu"]
  void removeSavedStates()
  // A model already in storage loads from it, without the network.
  const saved = await wllama.modelManager.getModels()
  const cached = saved.some((m) => m.url === url)
  // Copies earlier versions of this package saved at a pinned commit.
  const base = `https://huggingface.co/${meta.name}/resolve/`
  for (const old of saved) {
    if (old.url !== url && old.url.startsWith(base) && old.url.endsWith(`/${meta.file}`)) {
      void old.remove().catch(() => undefined)
    }
  }
  // Room for it first: other runtimes' models past the memory budget are
  // unloaded, by what it takes while it loads; once loaded, its claim drops
  // to what it keeps.
  const fileBytes =
    saved.find((m) => m.url === url)?.size ?? (await remoteSize(url, signal)) ?? 0
  const claim = (bytes: number) =>
    claimMemory({
      owner: OWNER,
      model,
      bytes,
      keepLoaded: keepLoaded.has(model),
      unload: unloadModel
    })
  await claim(fileBytes * factors.loading)
  // The download first, then wllama's start and the load, which has a
  // deadline of its own (see startupDeadline).
  const file = await wllama.modelManager.getModelOrDownload(
    { url },
    {
      signal,
      progressCallback: ({ loaded: bytes, total }) => {
        if (cached || signal.aborted) return
        // (0 until the server says the file's size.)
        downloading.add(model)
        progress(total ? Math.min(bytes / total, 1) : 0)
      }
    }
  )
  downloading.delete(model)
  signal.throwIfAborted()
  await withDeadline(
    wllama.loadModel(file, {
      // The caller's context, else 0: llama.cpp's "the model's training
      // context" (wllama's own default is 1,024 tokens, less than a system
      // prompt with tools). llama.cpp reserves the attention cache for all
      // of it now.
      n_ctx: contextLength ?? 0,
      // wllama's default otherwise: WebGPU where the browser has it.
      ...(options.gpu === false && { n_gpu_layers: 0 }),
      // The whole context in sliding-window layers' cache (LFM3's), not just
      // the window, so a follow-up can reuse what was read before: otherwise
      // LFM3 rereads the whole prompt after a tool call. +65 MB for LFM3;
      // nothing for models without such layers.
      swa_full: true,
      ...(options.threads && { n_threads: options.threads })
    }),
    startupDeadline(file.size > 0 ? file.size : fileBytes),
    `wllama didn't start or load ${meta.name} in time (is its WebAssembly file at ${wasmUrl()}?).`
  )
  // wllama 3.8.1 resolves the load even when llama.cpp couldn't load the
  // model or create its context (an unknown architecture, too little memory
  // for the cache), with `success: false` in the context info, and the first
  // request then aborts: https://github.com/ngxson/wllama/issues/311.
  const info = wllama.getLoadedContextInfo() as { success?: boolean }
  if (info.success === false) {
    throw new Error(
      `llama.cpp couldn't load ${meta.name} or create its context: its architecture may be newer than wllama's llama.cpp, or a smaller contextLength may fit (see the console).`
    )
  }
  await claim(fileBytes * factors.loaded)
  return wllama
}

/**
 * Loads a model (downloading it the first time), replacing any other. The
 * promise settles when it's ready to generate. `onDownloadProgress` hears
 * the download's progress, 0 to 1, then 1 once the model is ready (at once
 * if it already is).
 */
export function loadModel(
  model: WllamaChatModel,
  onDownloadProgress?: DownloadProgressCallback,
  loadOptions: {
    /**
     * Stops this caller's wait: it rejects at once with an AbortError (or,
     * for a chat's wait, the signal's reason) and hears no more progress. If
     * no other caller is waiting on the load, the download is cancelled too
     * and the model left unloaded.
     */
    signal?: AbortSignal
    /**
     * A chat's own wait for the model: it isn't told 1 if the model is
     * ready already, rejects with its signal's reason, and aborting it
     * leaves the download going for the next chat.
     */
    chatWait?: boolean
  } = {}
): Promise<Wllama> {
  const { signal, chatWait = false } = loadOptions
  const waitOptions = {
    onDownloadProgress,
    signal,
    ...(chatWait && { cancels: false, reason: (aborted: AbortSignal) => aborted.reason })
  }
  const contextLength = contextLengths.get(model)
  if (loaded?.model === model && loaded.contextLength === contextLength) {
    if (!loaded.ready || signal?.aborted) return loaded.waiters.wait(loaded.promise, waitOptions)
    // Every caller hears 1 at once if the model is ready already.
    if (onDownloadProgress && !chatWait) call(onDownloadProgress, 1)
    return loaded.promise
  }
  // An aborted caller starts nothing.
  if (signal?.aborted) {
    return new LoadWaiters(() => undefined).wait(Promise.resolve(undefined as unknown as Wllama), waitOptions)
  }
  let wllama: Wllama
  try {
    wllama = createWllama(options.debug ? console : LoggerWithoutDebug)
  } catch (error) {
    // wllama refuses to start here (no storage it can use, say): the model
    // loaded before, if any, stays.
    const failed = Promise.reject(error instanceof Error ? error : new Error(errorText(error)))
    failed.catch(() => undefined)
    return failed
  }
  const previous = loaded
  if (previous) downloading.delete(previous.model)
  const abort = new AbortController()
  // The last caller waiting gave up: stop the download and free wllama.
  const waiters = new LoadWaiters(() => {
    if (loaded === current) void unloadModel(model)
  })
  const report = (progress: number) => waiters.report(progress)
  const promise = (async () => {
    if (previous) {
      // Stop its download, if it's still downloading, and free it: exit()
      // ends its worker at once. A load that would never settle (see
      // startupDeadline) isn't waited for past a moment.
      previous.abort.abort()
      await withDeadline(previous.promise, 2_000, "").catch(() => undefined)
      await previous.wllama.exit().catch(() => undefined)
    }
    return startLoad(model, wllama, abort.signal, contextLength, report)
  })()
  const current = {
    model,
    contextLength,
    wllama,
    promise,
    abort,
    waiters,
    ready: false
  }
  loaded = current
  promise.then(
    () => {
      if (loaded === current) {
        current.ready = true
        report(1)
      }
      // Superseded while it loaded, after the next load stopped waiting:
      // free it now.
      else void wllama.exit().catch(() => undefined)
      waiters.settle()
    },
    () => {
      waiters.settle()
      // Superseded: the next load frees it.
      if (loaded !== current) return
      loaded = null
      downloading.delete(model)
      releaseMemory(OWNER)
      void wllama.exit().catch(() => undefined)
    }
  )
  promise.catch(() => undefined)
  // (After the handlers above, so a waiter hears the 1 they report.)
  return waiters.wait(promise, waitOptions)
}

/**
 * Whether wllama can run models in this browser: llama.cpp runs in
 * WebAssembly in a Web Worker, on WebGPU where wllama can drive it and on
 * the CPU elsewhere, and wllama keeps models in the Origin Private File
 * System. So wherever the browser has WebAssembly, workers and OPFS (not
 * on a server).
 */
function canRun() {
  return (
    typeof WebAssembly !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  )
}

/** wllama's model storage, read from the page (the Origin Private File System). */
let storage: ModelManager | undefined

/**
 * Where `model` stands in this browser, as the Prompt API's
 * `LanguageModel.availability()` says it: "unavailable" where wllama can't
 * run (no WebAssembly, Web Worker or Origin Private File System, as on a
 * server) or the model isn't known, "downloading" while this page downloads
 * it, "available" when it's loaded or its whole GGUF file is in wllama's
 * storage, else "downloadable". It lists wllama's storage only (its
 * ModelManager, which reads the Origin Private File System): no worker, no
 * WebAssembly, no network.
 */
export async function availability(model: WllamaChatModel): Promise<Availability> {
  if (!canRun()) return "unavailable"
  let url: string
  try {
    url = modelUrl(model)
  } catch {
    return "unavailable"
  }
  if (downloading.has(model)) return "downloading"
  if (loaded?.model === model && loaded.ready) return "available"
  try {
    storage ??= new ModelManager()
    const saved = await storage.getModels()
    if (downloading.has(model)) return "downloading"
    return saved.some((m) => m.url === url) ? "available" : "downloadable"
  } catch {
    return "downloadable"
  }
}

const count = new Intl.NumberFormat("en-US")

/** llama.cpp's error for a prompt past the context limit, said plainly. */
export function contextError(error: unknown, context: number) {
  const tokens = /request \((\d+) tokens\) exceeds the available context/.exec(
    errorText(error)
  )?.[1]
  if (!tokens) return error
  return new Error(
    `This session is too long for the model: ${count.format(Number(tokens))} tokens, and it can read ${count.format(context)} at most, reply included. Start a new session to keep going.`
  )
}

/** A chat completion request, as llama.cpp's OpenAI-compatible API takes it. */
export type ChatRequest = Omit<ChatCompletionParams, "stream" | "abortSignal"> & {
  /** llama.cpp's server reads it (wllama's types leave it out); its default is the chat template's support. */
  parallel_tool_calls?: boolean
}

/** Cancel this caller's wait while the shared model download keeps filling its cache. */
export async function waitForModel(
  model: WllamaChatModel,
  signal?: AbortSignal,
  onDownloadProgress?: DownloadProgressCallback
): Promise<Wllama> {
  signal?.throwIfAborted()
  return loadModel(model, onDownloadProgress, { ...(signal && { signal }), chatWait: true })
}

/** Streams a chat completion from `model`, loading it first. */
export async function streamChat(
  model: WllamaChatModel,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<AsyncIterable<ChatCompletionChunk>> {
  const wllama = await waitForModel(model, signal)
  signal?.throwIfAborted()
  touchMemory(OWNER)
  const chunks = await wllama.createChatCompletion({
    ...request,
    stream: true,
    ...(signal && { abortSignal: signal })
  })
  return chunks
}

/** A whole chat completion from `model`, loading it first. */
export async function completeChat(
  model: WllamaChatModel,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const wllama = await waitForModel(model, signal)
  signal?.throwIfAborted()
  touchMemory(OWNER)
  try {
    const response = await wllama.createChatCompletion({
      ...request,
      stream: false,
      ...(signal && { abortSignal: signal })
    })
    return response
  } catch (error) {
    throw contextError(error, loadedContext(wllama))
  }
}
