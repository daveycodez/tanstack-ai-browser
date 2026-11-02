/**
 * The page's side of wllama: llama.cpp compiled to WebAssembly, which runs
 * in wllama's own Web Worker. One model at a time: loading another frees
 * the previous one. Models download once to the Origin Private File
 * System, and load from there afterwards, offline included.
 */
import { BUILD_ID } from "../vendor/wllama/build-id.js"
import { LoggerWithoutDebug, Wllama } from "../vendor/wllama/index.js"
import type {
  ChatCompletionChunk,
  ChatCompletionParams,
  ChatCompletionResponse
} from "../vendor/wllama/index.js"

import { claimMemory, releaseMemory, touchMemory } from "./model-memory.js"
import { modelMeta, modelUrl } from "./model-meta.js"
import type { WllamaTextModel } from "./model-meta.js"
import { createStore } from "./store.js"
import type { Store } from "./store.js"

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
export function modelStatus(model: WllamaTextModel): Store<ModelStatus> {
  let status = statuses.get(model)
  if (!status) {
    status = createStore<ModelStatus>({ state: "idle" })
    statuses.set(model, status)
  }
  return status
}

/** Options that apply to the runtime, so to every model. */
export type RuntimeOptions = {
  /**
   * Where wllama's main WebAssembly file is served, for every browser that
   * runs the main build. By default the bundler emits this package's
   * builds (`wasm/`, see the README and scripts/build-wasm.sh).
   */
  wasmUrl?: string
  /**
   * Where this package's relaxed SIMD build is served
   * (`wasm/wllama-relaxed.wasm`), or `false` to use the main build without
   * it. Browsers with relaxed SIMD (Chrome, Firefox) use it; by default the
   * bundler emits it from this package.
   */
  relaxedSimdWasmUrl?: string | false
  /**
   * Where the compat build is served: its WebAssembly file and its worker
   * script. Browsers without JSPI or 64-bit WebAssembly memory (Safari) run
   * it instead of the main build, which doesn't run there. By default the
   * bundler emits both from this package (`wasm/wllama-compat.*`).
   */
  compat?: { wasm: string; worker: string }
  /** CPU threads. wllama's default otherwise: half the cores. */
  threads?: number
  /**
   * `false` to run on the CPU only. By default, wllama's: on WebGPU where
   * the browser has it (Chrome, Edge, Safari), on the CPU elsewhere
   * (Firefox, which has no JSPI, and browsers without WebGPU).
   */
  gpu?: boolean
  /**
   * Speculative decoding: guesses of the next few tokens, taken from the
   * conversation so far (n-grams), checked in one pass, so text that repeats
   * the prompt (code edits, summaries, tool results) is written several
   * tokens at a time. By default on where it gives the same text as without
   * it and is faster: WebGPU on Imagination PowerVR GPUs (the Pixel 10's),
   * whose kernels score a batch of tokens exactly as one at a time. `true`
   * turns it on everywhere (elsewhere the text may differ slightly, as a
   * batch is computed in another order), `false` off.
   */
  speculative?: boolean
  /**
   * Sampling from the logits' top 128, found on the GPU, instead of reading
   * every logit back and sorting them on the CPU, when the sampling settings
   * keep at most the top 127 anyway (top-k after only repeat penalties and
   * logit biases that lower logits); the same tokens are sampled, and other
   * requests read every logit. By default on where it is faster: WebGPU on
   * Imagination PowerVR GPUs. `false` turns it off.
   */
  gpuTopK?: boolean
  /** wllama's and llama.cpp's logs, in the console. */
  debug?: boolean
}

let options: RuntimeOptions = {}

/** Sets runtime options; they apply from the next model load. */
export function configureRuntime(next: RuntimeOptions) {
  options = { ...options, ...next }
}

// This package's builds of wllama (scripts/build-wasm.sh): llama.cpp new
// enough for LFM3, with its WebAssembly SIMD kernels, which wllama's own
// builds leave out. wllama's JavaScript (vendor/wllama) comes from the same
// build, with slot state save and restore added.

/**
 * The full URL of a file of this package's `wasm/`, from its URL next to
 * this module. Turbopack (Next.js) makes that URL a path, which the compat
 * worker can't load. Vite's dev server pre-bundles the package into
 * node_modules/.vite/deps, which moves these URLs to node_modules/.vite/wasm,
 * where it serves no files; it does serve the package's own, so they're used
 * instead.
 */
function packageFile(url: URL) {
  const file = new URL(url.href, location.href)
  if (!file.pathname.includes("/node_modules/.vite/")) return file.href
  const name = file.pathname.slice(file.pathname.lastIndexOf("/") + 1)
  return new URL(`/node_modules/@tanstack-ai-browser/wllama/wasm/${name}`, file)
    .href
}

/** The main build. */
const defaultWasmUrl = () =>
  packageFile(new URL("../wasm/wllama.wasm", import.meta.url))

/**
 * The main build with relaxed SIMD dot products as well: about twice as
 * fast at reading prompts as wllama's own build.
 */
const relaxedWasmUrl = () =>
  packageFile(new URL("../wasm/wllama-relaxed.wasm", import.meta.url))

/** A WebAssembly module with one relaxed SIMD instruction (i32x4.relaxed_dot_i8x16_i7x16_add_s). */
const RELAXED_SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 123, 1, 123, 3, 2, 1, 0, 10, 13,
  1, 11, 0, 32, 0, 32, 0, 32, 0, 253, 147, 2, 11
])

function hasRelaxedSimd() {
  try {
    return WebAssembly.validate(RELAXED_SIMD_MODULE)
  } catch {
    return false
  }
}

/** The main build to load: the faster one where the browser can run it. */
function mainWasmUrl() {
  if (options.wasmUrl) return options.wasmUrl
  if (options.relaxedSimdWasmUrl !== false && hasRelaxedSimd()) {
    return options.relaxedSimdWasmUrl ?? relaxedWasmUrl()
  }
  return defaultWasmUrl()
}

/**
 * The compat build, with the glue from the same build. The glue ships as
 * `.js.txt` so bundlers emit it as is: `next build --webpack` minifies `.js`
 * files emitted this way, which breaks it.
 */
const defaultCompat = () => ({
  wasm: packageFile(new URL("../wasm/wllama-compat.wasm", import.meta.url)),
  worker: packageFile(new URL("../wasm/wllama-compat.js.txt", import.meta.url))
})

/** A WebAssembly module with only a 64-bit memory. */
const MEMORY64_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1
])

/**
 * Whether wllama's compat build has to run here: without JSPI, or without
 * 64-bit WebAssembly memory, checked by compiling a module that has one.
 * (Safari accepts `new WebAssembly.Memory({ address: "i64" })`, wllama's own
 * check, but can't compile the main build.) Not in Firefox, which runs the
 * main build without JSPI.
 */
function needsCompat() {
  if (/Firefox\//.test(navigator.userAgent)) return false
  return (
    !("Suspending" in WebAssembly) || !WebAssembly.validate(MEMORY64_MODULE)
  )
}

/**
 * Runs `wllama` on its compat build. wllama only uses one where its own
 * checks say so, and they pass in Safari, which then fails to compile the
 * main build (and the load never ends), so its worker's resources are set
 * here too.
 */
function useCompat(
  wllama: Wllama,
  compat: { wasm: string; worker: { code: string } }
) {
  wllama.setCompat(compat)
  const target = wllama as unknown as { getWorkerResources: () => object }
  const resources = target.getWorkerResources.bind(wllama)
  target.getWorkerResources = () => ({
    ...resources(),
    wasmPath: compat.wasm,
    jsPath: compat.worker,
    compat: true
  })
}

let compatCode: Promise<string> | undefined

/**
 * The compat build, served with the site rather than from wllama's CDN,
 * so it works offline too. wllama wraps the worker script in a
 * function, so it's passed as code that ends in a newline: a bundler's
 * dev server may end it in a `//# sourceMappingURL` comment, which would
 * otherwise comment out the end of that function.
 */
async function compatBuild() {
  const { wasm, worker } = options.compat ?? defaultCompat()
  compatCode ??= fetch(worker).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        `Couldn't load wllama's compat build (${response.status}).`
      )
    }
    return `${await response.text()}\n`
  })
  compatCode.catch(() => {
    compatCode = undefined
  })
  return { wasm, worker: { code: await compatCode } }
}

/** The model wllama holds (or is loading), its load, and a way to stop it. */
let loaded: {
  model: WllamaTextModel
  contextLength: number | undefined
  wllama: Wllama
  promise: Promise<Wllama>
  abort: AbortController
} | null = null

/** This runtime's name in the shared memory registry. */
const OWNER = "wllama"

/** Models never unloaded to make room for another runtime's (see setKeepLoaded). */
const keepLoaded = new Set<WllamaTextModel>()

/**
 * Keeps `model` loaded when another runtime (Transformers.js, WebGL) loads a
 * model past the memory budget; by default the least recently used goes.
 */
export function setKeepLoaded(model: WllamaTextModel, keep: boolean) {
  if (keep) keepLoaded.add(model)
  else keepLoaded.delete(model)
}

/**
 * Frees the loaded model (stopping its download, if it's downloading).
 * Another runtime loading a model past the memory budget calls it too.
 */
export async function unloadModel() {
  const current = loaded
  releaseMemory(OWNER)
  if (!current) return
  loaded = null
  modelStatus(current.model).set({ state: "idle" })
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
const contextLengths = new Map<WllamaTextModel, number>()

/**
 * Sets the most tokens a chat with `model` may hold, prompt and reply
 * together; undefined for the model's whole context window (its GGUF's
 * training context). llama.cpp reserves the attention cache for all of it
 * when the model loads, so it applies from the next load.
 */
export function setContextLength(
  model: WllamaTextModel,
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

let askedToKeep = false
/**
 * Asks the browser to keep this site's storage, so a downloaded model isn't
 * deleted to free space or, in Safari, after 7 days without a visit.
 * Browsers may say no; it's only a request. Called when a download starts,
 * not for cached loads. Skipped in Firefox, which shows a permission prompt
 * for it; there a model is still kept across reloads, unless the disk runs
 * low.
 */
function keepDownloads() {
  if (askedToKeep || typeof navigator === "undefined") return
  askedToKeep = true
  if (/firefox/i.test(navigator.userAgent)) return
  navigator.storage?.persist?.().catch(() => undefined)
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

// The model's state after a chat (what it has read, as llama.cpp's slot
// save file), kept in the Origin Private File System so the first message
// after a reload doesn't read the system prompt and tools again: llama.cpp
// reuses the start of the prompt that matches the restored one, and a state
// that doesn't match is simply not reused. One per model, saved again when
// the system prompt or tools change.

const STATE_DIR = "wllama-state"

/** What a saved state is for: the model's file, the build that saved it, and the prefix it starts with. */
type StateInfo = {
  url: string
  build: string
  prefix: string
  savedAt: number
}

const debug = (...args: unknown[]) => {
  if (options.debug) console.debug("[wllama state]", ...args)
}

/** The model's files in STATE_DIR. */
const stateFiles = async (model: WllamaTextModel) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(STATE_DIR, { create: true })
  const name = model.replace(/[^\w.-]/g, "_")
  return { dir, data: `${name}.bin`, info: `${name}.json` }
}

/** The system prompt and tools of a request, as a short hash and its length. */
function prefixKey(request: ChatRequest) {
  const text = JSON.stringify([
    request.messages.filter((message) => message.role === "system"),
    request.tools ?? []
  ])
  // FNV-1a: a collision only skips a save.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

/** The loaded model's build and saved prefix, set by startLoad. */
let state: { model: WllamaTextModel; build: string; prefix?: string } | null =
  null
let saving = false

/** Saves the model's state after a chat, unless one with the same system prompt and tools is saved. */
async function saveState(
  model: WllamaTextModel,
  wllama: Wllama,
  request: ChatRequest
) {
  const current = state
  const prefix = prefixKey(request)
  if (current?.model !== model || current.prefix === prefix || saving) return
  saving = true
  try {
    const start = performance.now()
    const data = await wllama.saveSlotState()
    const saved = performance.now()
    const { dir, data: dataName, info: infoName } = await stateFiles(model)
    const info: StateInfo = {
      url: modelUrl(model),
      build: current.build,
      prefix,
      savedAt: Date.now()
    }
    const write = async (name: string, content: FileSystemWriteChunkType) => {
      const file = await dir.getFileHandle(name, { create: true })
      const writable = await file.createWritable()
      await writable.write(content)
      await writable.close()
    }
    // wllama's copy of the bytes, not its shared memory.
    await write(dataName, data as Uint8Array<ArrayBuffer>)
    await write(infoName, JSON.stringify(info))
    current.prefix = prefix
    debug(
      `saved ${(data.byteLength / 1e6).toFixed(1)} MB in ${Math.round(saved - start)} ms (+${Math.round(performance.now() - saved)} ms to write)`
    )
  } catch (error) {
    debug("not saved:", error)
  } finally {
    saving = false
  }
}

/** Restores the model's saved state, if it's from this build. */
async function restoreState(model: WllamaTextModel, wllama: Wllama) {
  const current = state
  try {
    const start = performance.now()
    const { dir, data, info: infoName } = await stateFiles(model)
    const file = async (name: string) =>
      (await dir.getFileHandle(name)).getFile()
    const info = JSON.parse(await (await file(infoName)).text()) as StateInfo
    if (info.url !== modelUrl(model) || info.build !== current?.build) return
    const bytes = new Uint8Array(await (await file(data)).arrayBuffer())
    const read = performance.now()
    const tokens = await wllama.restoreSlotState(bytes)
    current.prefix = info.prefix
    debug(
      `restored ${tokens} tokens, ${(bytes.byteLength / 1e6).toFixed(1)} MB, in ${Math.round(performance.now() - read)} ms (+${Math.round(read - start)} ms to read)`
    )
  } catch (error) {
    debug("not restored:", error)
  }
}

/**
 * llama.cpp's n-gram speculative decoding (ngram-simple): the longest of the
 * last 4 tokens to 1 token that occurred before drafts what followed it, up
 * to 7 tokens. How many is chosen by cost (this package's patch): how likely
 * each next guess is right, learnt as the reply goes on for each length of
 * match, against how long a pass of that many tokens takes, measured as it
 * goes; nothing when no draft would pay, or when the match's older
 * occurrences disagree on what comes next.
 */
const SPECULATIVE = {
  spec_type: "ngram-simple",
  spec_ngram_size_n: 4,
  spec_ngram_size_n_min: 1,
  spec_ngram_size_m: 7
}

/**
 * Whether models run on WebGPU here, as wllama sets them up: where the
 * browser has a WebGPU adapter and the build can drive it (JSPI in the main
 * build; the compat build Safari runs), unless `gpu: false`. Elsewhere
 * (Firefox, which has no JSPI, and browsers without WebGPU) llama.cpp runs
 * on the CPU in WebAssembly.
 */
export async function runsOnWebGpu(): Promise<boolean> {
  return (await webGpuAdapter()) !== null
}

/** The WebGPU adapter models run on here (see `runsOnWebGpu`), or null. */
async function webGpuAdapter(): Promise<GPUAdapter | null> {
  if (options.gpu === false || typeof navigator === "undefined") return null
  if (!("gpu" in navigator)) return null
  if (!("Suspending" in WebAssembly) && !needsCompat()) return null
  try {
    return await navigator.gpu.requestAdapter()
  } catch {
    return null
  }
}

/**
 * Whether models run on WebGPU on an Imagination PowerVR GPU here (the Pixel
 * 10's), in the main build: not where llama.cpp runs on the CPU (Firefox,
 * which has no JSPI), whose batches aren't computed as the PowerVR shaders
 * compute them.
 */
async function onPowerVR() {
  if (needsCompat()) return false
  const adapter = await webGpuAdapter()
  return adapter?.info.vendor === "img-tec"
}

/** Whether to decode speculatively (see `RuntimeOptions.speculative`). */
async function useSpeculative() {
  if (options.speculative !== undefined) return options.speculative
  return onPowerVR()
}

/**
 * The logits' top k read back for sampling (see `RuntimeOptions.gpuTopK`),
 * or undefined: every logit is read back.
 */
async function gpuTopK() {
  if (options.gpuTopK === false || options.gpu === false) return undefined
  return (await onPowerVR()) ? 128 : undefined
}

/**
 * Whether to keep a tied token embedding on the GPU only (wllama's
 * `token_embd_gpu`): on WebGPU, where llama.cpp otherwise holds the
 * vocabulary table twice, the output head on the GPU and a copy for the
 * embedding on the CPU (398 MB for Qwen3.5 2B, 205 MB for LFM3). wllama
 * checks the file: only models with no separate `output.weight`. Not on
 * PowerVR, where Q4_K and Q6_K weights are repacked for the matrix products
 * as they're uploaded, and the embedding's row lookups read them as stored.
 */
async function tokenEmbdOnGpu(onGpu: boolean) {
  return onGpu && !(await onPowerVR())
}

/**
 * Contexts a CPU load falls back to, in turn, when the model's whole window
 * doesn't fit: there llama.cpp's attention cache is in WebAssembly's memory,
 * which wllama caps at 4 GB (Qwen3.5 2B's 262,144 tokens take 3 GB).
 */
const CPU_FALLBACK_CONTEXTS = [32_768, 8_192]

/** Whether wllama failed to load the model or create its context. */
function isContextLoadError(error: unknown) {
  return (
    error instanceof Error &&
    (error as { type?: string }).type === "load_error" &&
    error.message.startsWith("Failed to load the model or create its context")
  )
}

async function startLoad(
  model: WllamaTextModel,
  wllama: Wllama,
  signal: AbortSignal,
  contextLength: number | undefined
) {
  const status = modelStatus(model)
  const url = modelUrl(model)
  const meta = modelMeta(model)
  const compat = needsCompat() ? await compatBuild() : null
  if (compat) useCompat(wllama, compat)
  const speculative = await useSpeculative()
  const topK = await gpuTopK()
  const onGpu = await runsOnWebGpu()
  const tokenEmbdGpu = await tokenEmbdOnGpu(onGpu)
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
  status.set({ state: "loading", progress: 0, cached })
  if (!cached) keepDownloads()
  // Room for it first: other runtimes' models past the memory budget are
  // unloaded. It takes about its file's size, plus the attention cache.
  const fileBytes =
    saved.find((m) => m.url === url)?.size ?? (await remoteSize(url, signal))
  await claimMemory({
    owner: OWNER,
    model,
    bytes: (fileBytes ?? 0) * 1.15,
    keepLoaded: keepLoaded.has(model),
    unload: unloadModel
  })
  const loadOnce = (nCtx: number) =>
    wllama.loadModelFromUrl(url, {
      n_ctx: nCtx,
      // wllama's default otherwise: WebGPU where the browser has it.
      ...(options.gpu === false && { n_gpu_layers: 0 }),
      // The whole context in sliding-window layers' cache (LFM3's), not just
      // the window, so a follow-up can reuse what was read before: otherwise
      // LFM3 rereads the whole prompt after a tool call. +65 MB for LFM3;
      // nothing for models without such layers.
      swa_full: true,
      ...(options.threads && { n_threads: options.threads }),
      ...(speculative && SPECULATIVE),
      ...(topK && { logits_topk: topK }),
      ...(tokenEmbdGpu && { token_embd_gpu: true }),
      signal,
      progressCallback: ({ loaded: bytes, total }) => {
        if (cached) return
        // (0 until the server says the file's size.)
        const totalBytes = total
        status.set({
          state: "loading",
          progress: totalBytes ? Math.min(bytes / totalBytes, 1) : 0,
          cached: false,
          loadedBytes: bytes,
          totalBytes
        })
      }
    })
  // The caller's context, else 0: llama.cpp's "the model's training context"
  // (wllama's own default is 1,024 tokens, less than a system prompt with
  // tools). llama.cpp reserves the attention cache for all of it now. On the
  // CPU with no context set, a load it doesn't fit in is retried smaller
  // (CPU_FALLBACK_CONTEXTS); a context the caller set is never changed, and
  // WebGPU keeps the model's own.
  const contexts =
    contextLength === undefined && !onGpu
      ? [0, ...CPU_FALLBACK_CONTEXTS]
      : [contextLength ?? 0]
  for (const [attempt, nCtx] of contexts.entries()) {
    // Saved slot states only restore into the same build and setup
    // (speculative decoding keeps extra recurrent-state snapshots).
    state = {
      model,
      build: `${BUILD_ID} ${compat?.wasm ?? mainWasmUrl()}${speculative ? " speculative" : ""} n_ctx ${nCtx}`
    }
    try {
      await loadOnce(nCtx)
      break
    } catch (error) {
      const next = contexts[attempt + 1]
      if (next === undefined || signal.aborted || !isContextLoadError(error)) {
        throw error
      }
      console.warn(
        `[wllama] ${meta.name} didn't fit in memory with ${nCtx ? `${count.format(nCtx)} tokens` : "its whole context"} on the CPU; loading it with ${count.format(next)}.`
      )
    }
  }
  await restoreState(model, wllama)
  return wllama
}

/**
 * Loads a model (downloading it the first time), replacing any other. The
 * promise settles when it's ready to generate.
 */
export function loadModel(model: WllamaTextModel): Promise<Wllama> {
  const contextLength = contextLengths.get(model)
  if (loaded?.model === model && loaded.contextLength === contextLength) {
    return loaded.promise
  }
  const previous = loaded
  if (previous) modelStatus(previous.model).set({ state: "idle" })
  const wllama = new Wllama(
    { default: mainWasmUrl() },
    {
      logger: options.debug ? console : LoggerWithoutDebug,
      suppressNativeLog: !options.debug
    }
  )
  const status = modelStatus(model)
  status.set({ state: "loading", progress: 0, cached: true })
  const abort = new AbortController()
  const promise = (async () => {
    if (previous) {
      // Stop its download, if it's still downloading, and free it.
      previous.abort.abort()
      await previous.promise.catch(() => undefined)
      await previous.wllama.exit().catch(() => undefined)
    }
    return startLoad(model, wllama, abort.signal, contextLength)
  })()
  const current = { model, contextLength, wllama, promise, abort }
  loaded = current
  promise.then(
    () => {
      if (loaded === current) status.set({ state: "ready" })
    },
    (error: unknown) => {
      if (loaded !== current) return
      loaded = null
      releaseMemory(OWNER)
      status.set({ state: "error", message: errorText(error) })
      void wllama.exit().catch(() => undefined)
    }
  )
  promise.catch(() => undefined)
  return promise
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
export type ChatRequest = Omit<ChatCompletionParams, "stream" | "abortSignal">

/** Cancel this caller's wait while the shared model download keeps filling its cache. */
export async function waitForModel(model: WllamaTextModel, signal?: AbortSignal): Promise<Wllama> {
  signal?.throwIfAborted()
  const loading = loadModel(model)
  if (!signal) return loading
  return new Promise<Wllama>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted)
      reject(signal.reason)
    }
    signal.addEventListener("abort", aborted, { once: true })
    loading.then(
      value => {
        signal.removeEventListener("abort", aborted)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      error => {
        signal.removeEventListener("abort", aborted)
        reject(error)
      }
    )
    // Also cover an abort during synchronous model setup before the listener.
    if (signal.aborted) aborted()
  })
}

/** Streams a chat completion from `model`, loading it first. */
export async function streamChat(
  model: WllamaTextModel,
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
  return (async function* () {
    yield* chunks
    void saveState(model, wllama, request)
  })()
}

/** A whole chat completion from `model`, loading it first. */
export async function completeChat(
  model: WllamaTextModel,
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
    void saveState(model, wllama, request)
    return response
  } catch (error) {
    throw contextError(error, loadedContext(wllama))
  }
}
