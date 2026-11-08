/**
 * The one `WebGLLM` instance every adapter and helper here shares, and the
 * page-side state around it: which models are ready, and
 * its place in the memory registry this project's runtimes share
 * (model-memory.ts), so a WebGL model and a Transformers.js or wllama one
 * make room for each other.
 */
import { WebGLLM } from "webgllm"
import { defaultMemoryBudget } from "webgllm/advanced"

import type { LoadProgress } from "webgllm"

import { WEBGLLM_MODEL_META } from "./catalog.js"
import type { WebGllmChatModel } from "./catalog.js"
import {
  claimMemory,
  releaseMemory,
  setMemoryBudget as setRegistryBudget,
  touchMemory
} from "./model-memory.js"

/**
 * Where a model stands, with the Prompt API's values
 * (`LanguageModel.availability()`): "unavailable" (it can't run here),
 * "downloadable" (it can: loading it downloads it, or reads it from
 * storage), "downloading" or "available" (loaded and ready in this page).
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

/** The registry's budget (set by any runtime's setMemoryBudget), else the device's. */
function registryBudget(): number {
  // Read straight from the shared registry (see model-memory.ts), whose
  // copies in the other packages can set it too.
  const scope = globalThis as unknown as Record<symbol, { budget?: number } | undefined>
  return scope[Symbol.for("@tanstack-ai-browser/model-memory")]?.budget ?? defaultMemoryBudget()
}

/**
 * The shared instance. Each claim its workers make (an estimate before a
 * load, the measured textures after, each growth of the attention cache)
 * goes to the registry first, which makes room across runtimes before the
 * worker allocates. webgllm's own budget holds its models to the same limit
 * and orders them among themselves. webgllm reads `memoryBudget` from its
 * options at each claim, so the getter follows `setMemoryBudget`.
 */
export const webgllm = new WebGLLM({
  get memoryBudget() {
    return registryBudget()
  },
  onMemoryClaim: async ({ model, bytes, signal }) => {
    await claimMemory({
      owner: owner(model),
      model,
      bytes,
      keepLoaded: keepLoaded.has(model),
      unload: () => evict(model)
    })
    // Unloaded while the registry made room: its "unload" event has already
    // released it, so hold nothing for it.
    if (signal.aborted) releaseMemory(owner(model))
  }
})

/**
 * Where `model` stands, as the Prompt API's `LanguageModel.availability()`
 * says it: "unavailable" where the engine can't run (WebGL 2 with float
 * render targets, in a worker; not on a server) or the model isn't in
 * webgllm's catalog, "available" when it's loaded and ready in this page,
 * else "downloadable", while a load is in progress and when its files are
 * in webgllm's storage too. No storage reads, no worker, no network.
 */
export async function availability(model: WebGllmChatModel): Promise<Availability> {
  if (!WebGLLM.isSupported() || !(model in WEBGLLM_MODEL_META)) return "unavailable"
  return ready.has(model) ? "available" : "downloadable"
}

/**
 * Sets how many bytes the page's models may take together, across this
 * project's runtimes, from the next load on; undefined for the default.
 */
export function setMemoryBudget(bytes: number | undefined) {
  setRegistryBudget(bytes)
}

/** Models loaded and ready, whatever loaded them. */
const ready = new Set<string>()

/** Each loading model's callers' download progress callbacks, until it settles. */
const listeners = new Map<string, Set<DownloadProgressCallback>>()

function call(listener: DownloadProgressCallback, progress: number) {
  try {
    listener(progress)
  } catch (error) {
    console.error(error)
  }
}

/** Calls `model`'s progress callbacks; once it's ready, forgets them. */
function report(model: string, progress: number, settled = false) {
  const waiting = listeners.get(model)
  if (!waiting) return
  if (settled) listeners.delete(model)
  for (const listener of waiting) call(listener, progress)
}

/** Adds a progress callback to `model`'s load. */
function listen(model: string, listener: DownloadProgressCallback | undefined) {
  if (!listener) return
  let waiting = listeners.get(model)
  if (!waiting) listeners.set(model, (waiting = new Set()))
  waiting.add(listener)
}

/** Models never unloaded to make room for another (see setKeepLoaded). */
const keepLoaded = new Set<string>()

/**
 * Keeps `model` loaded when another model (of this runtime or of
 * Transformers.js or wllama) loads past the memory budget; by default the
 * least recently used goes. Applies from the model's next load.
 */
export function setKeepLoaded(model: WebGllmChatModel, keep: boolean) {
  if (keep) keepLoaded.add(model)
  else keepLoaded.delete(model)
}

/** A model's name in the registry: webgllm holds several models, each its own entry. */
const owner = (model: string) => `webgllm:${model}`

/** The context each ready model was loaded for, as requested (undefined: the model's own). */
const loadedFor = new Map<string, number | undefined>()

/** The registry unloads `model` to make room for another runtime's (or another webgllm model). */
function evict(model: string): Promise<void> {
  // webgllm's "unload" event then marks it idle and releases its claim.
  return webgllm.unloadModel(model).catch(() => undefined)
}

/**
 * Loads `model` for `contextLength`. Its memory is claimed from the worker
 * (see onMemoryClaim) and released at its "unload" event, and its state
 * here follows webgllm's events (see below), not this function. Nothing is awaited
 * before webgllm takes the load, so an unloadModel() from here on reaches it.
 * A caller that gives up releases nothing: webgllm shares one load between
 * its callers and unloads (releasing it) only when the last one leaves.
 */
async function load(model: WebGllmChatModel, contextLength: number | undefined, signal?: AbortSignal) {
  await webgllm.loadModel(model, {
    ...(contextLength !== undefined && { contextLength }),
    keepLoaded: keepLoaded.has(model),
    ...(signal && { signal })
  })
  loadedFor.set(model, contextLength)
}

/**
 * Loads a model ahead of time (downloading it the first time) for chats of
 * up to `contextLength` tokens: the model's own context length by default.
 * A different context length loads the model again. Other models stay
 * loaded while they fit the memory budget. `onDownloadProgress` hears the
 * download's progress, 0 to 1, then 1 once the model is ready (at once if
 * it already is).
 */
export function loadModel(
  model: WebGllmChatModel,
  options: { contextLength?: number; onDownloadProgress?: DownloadProgressCallback } = {}
): Promise<void> {
  const { contextLength, onDownloadProgress } = options
  const promise = ensureModel(model, contextLength, undefined, onDownloadProgress, true)
  // Callers may leave it: an unawaited failure isn't an unhandled rejection.
  promise.catch(() => undefined)
  return promise
}

/**
 * The model loaded for `contextLength` (as requested), loading it if it
 * isn't: what each adapter call waits for before its request.
 */
export async function ensureModel(
  model: WebGllmChatModel,
  contextLength: number | undefined,
  signal?: AbortSignal,
  onDownloadProgress?: DownloadProgressCallback,
  /** Tell `onDownloadProgress` 1 at once if the model is ready already. */
  reportReady = false
): Promise<void> {
  signal?.throwIfAborted()
  if (ready.has(model) && loadedFor.has(model) && loadedFor.get(model) === contextLength) {
    touchMemory(owner(model))
    if (reportReady && onDownloadProgress) call(onDownloadProgress, 1)
    return
  }
  listen(model, onDownloadProgress)
  try {
    await load(model, contextLength, signal)
  } catch (error) {
    // This caller is done waiting; others keep theirs.
    if (onDownloadProgress) listeners.get(model)?.delete(onDownloadProgress)
    throw error
  }
}

/** Marks `model` as just used, for least recently used order across runtimes. */
export function touchModel(model: WebGllmChatModel) {
  touchMemory(owner(model))
}

/**
 * Unloads `model`, or every model, freeing its GPU memory; a running
 * generation of it fails. Never rejects (callers often don't wait for it).
 */
export function unloadModel(model?: WebGllmChatModel): Promise<void> {
  return webgllm.unloadModel(model).catch(() => undefined)
}

/**
 * A download's share of the way, 0 to 1, from webgllm's progress (which
 * spans downloading, 0 to 0.9, and reading the files into the GPU).
 */
const downloadShare = ({ progress, loadedBytes, totalBytes }: LoadProgress) =>
  totalBytes ? Math.min((loadedBytes ?? 0) / totalBytes, 1) : Math.min(progress / 0.9, 1)

// webgllm only dispatches events for models in its catalog. The state here
// follows webgllm's lifecycle events, whatever started the load (loadModel,
// a completion loading on demand) or the unload (unloadModel, room for
// another model, a crash).
webgllm.addEventListener("progress", (progress) => {
  if (progress.phase !== "download" || progress.cached) return
  report(progress.model, downloadShare(progress))
})

webgllm.addEventListener("load", ({ model }) => {
  ready.add(model)
  touchMemory(owner(model))
  report(model, 1, true)
})

webgllm.addEventListener("error", ({ model }) => {
  ready.delete(model)
})

webgllm.addEventListener("unload", ({ model }) => {
  ready.delete(model)
  loadedFor.delete(model)
  releaseMemory(owner(model))
})
