/**
 * The one `WebGLLM` instance every adapter and helper here shares, and the
 * page-side state around it: each model's loading status as a store, and
 * its place in the memory registry this project's runtimes share
 * (model-memory.ts), so a WebGL model and a Transformers.js or wllama one
 * make room for each other.
 */
import { WebGLLM } from "webgllm"
import type { LoadProgress } from "webgllm"
import { defaultMemoryBudget } from "webgllm/advanced"

import type { WebGlTextModel } from "./catalog.js"
import {
  claimMemory,
  releaseMemory,
  setMemoryBudget as setRegistryBudget,
  touchMemory
} from "./model-memory.js"

/** A value that can be read, set and watched. Framework-free. */
export type Store<T> = {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export type ModelStatus =
  | { state: "idle" }
  | {
      state: "loading"
      /** 0-1 across downloading and uploading to the GPU. */
      progress: number
      /** True when the files come from the browser's storage, not the network. */
      cached: boolean
      loadedBytes?: number
      totalBytes?: number
    }
  | { state: "ready" }
  | { state: "error"; message: string }

/** The registry's budget (set by any runtime's setMemoryBudget), else the device's. */
function registryBudget(): number {
  // Read straight from the shared registry (see model-memory.ts), whose
  // copies in the other packages can set it too.
  const scope = globalThis as unknown as Record<symbol, { budget?: number } | undefined>
  return scope[Symbol.for("@tanstack-ai-browser/model-memory")]?.budget ?? defaultMemoryBudget()
}

/**
 * The shared instance. Its own memory budget is the registry's: the registry
 * makes room across runtimes from estimates before a load, and webgllm's
 * budget then holds its own models to the same limit with the bytes its
 * workers measure (the attention cache grows as chats do). With the same
 * limit, webgllm only ever unloads models the registry would also have to,
 * and never refuses room the registry granted. webgllm reads
 * `memoryBudget` from its options at each claim, so the getter follows
 * `setMemoryBudget`.
 */
export const webgllm = new WebGLLM({
  get memoryBudget() {
    return registryBudget()
  }
})

/** Whether this browser can run the engine (WebGL 2 with float render targets, in a worker). */
export function isSupported(): boolean {
  return WebGLLM.isSupported()
}

/**
 * Sets how many bytes the page's models may take together, across this
 * project's runtimes, from the next load on; undefined for the default.
 */
export function setMemoryBudget(bytes: number | undefined) {
  setRegistryBudget(bytes)
}

const statuses = new Map<string, Store<ModelStatus>>()

/** Loading status of a model, by its name. */
export function modelStatus(model: WebGlTextModel): Store<ModelStatus> {
  let status = statuses.get(model)
  if (!status) {
    status = createStore<ModelStatus>({ state: "idle" })
    statuses.set(model, status)
  }
  return status
}

/** Models never unloaded to make room for another (see setKeepLoaded). */
const keepLoaded = new Set<string>()

/**
 * Keeps `model` loaded when another model (of this runtime or of
 * Transformers.js or wllama) loads past the memory budget; by default the
 * least recently used goes. Applies from the model's next load.
 */
export function setKeepLoaded(model: WebGlTextModel, keep: boolean) {
  if (keep) keepLoaded.add(model)
  else keepLoaded.delete(model)
}

/** A model's name in the registry: webgllm holds several models, each its own entry. */
const owner = (model: string) => `webgllm:${model}`

/**
 * The textures a model takes loaded, per byte of its weight files (what the
 * old in-repo worker measured: 1.3–1.4× at 512-token prompt batches).
 */
const TEXTURES_PER_FILE_BYTE = 1.4

/** A model's memory once loaded, estimated from its download size (0 when unknown). */
async function estimateBytes(model: string): Promise<number> {
  try {
    const { size } = await webgllm.models.retrieve(model)
    return Math.round(size * TEXTURES_PER_FILE_BYTE)
  } catch {
    return 0
  }
}

/** The context each ready model was loaded for, as requested (undefined: the model's own). */
const loadedFor = new Map<string, number | undefined>()
/** Loads of each model this module is waiting on. */
const loads = new Map<string, number>()
/**
 * Bumped when a model is unloaded, so a load that was running then doesn't
 * mark it ready or failed afterwards.
 */
const epochs = new Map<string, number>()

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Forgets `model` as loaded: idle, out of the registry, and stale loads ignored. */
function forget(model: string) {
  epochs.set(model, (epochs.get(model) ?? 0) + 1)
  loadedFor.delete(model)
  releaseMemory(owner(model))
  const status = modelStatus(model)
  if (status.get().state !== "idle") status.set({ state: "idle" })
}

/** The registry unloads `model` to make room for another runtime's (or another webgllm model). */
function evict(model: string): Promise<void> {
  forget(model)
  return webgllm.unloadModel(model).catch(() => undefined)
}

async function claim(model: string, bytes: number) {
  await claimMemory({
    owner: owner(model),
    model,
    bytes,
    keepLoaded: keepLoaded.has(model),
    unload: () => evict(model)
  })
}

/** Loads `model` for `contextLength`, claiming its memory first and driving its status. */
async function load(model: WebGlTextModel, contextLength: number | undefined, signal?: AbortSignal) {
  const epoch = epochs.get(model) ?? 0
  const current = () => (epochs.get(model) ?? 0) === epoch
  const status = modelStatus(model)
  loads.set(model, (loads.get(model) ?? 0) + 1)
  if (status.get().state !== "loading") status.set({ state: "loading", progress: 0, cached: true })
  try {
    // Make room before the load, so two big models aren't in memory at once.
    const bytes = await estimateBytes(model)
    signal?.throwIfAborted()
    await claim(model, bytes)
    await webgllm.loadModel(model, {
      ...(contextLength !== undefined && { contextLength }),
      keepLoaded: keepLoaded.has(model),
      ...(signal && { signal })
    })
    if (!current()) return
    loadedFor.set(model, contextLength)
    status.set({ state: "ready" })
    // Its size wasn't known before it downloaded: claim what it is now.
    if (bytes === 0) await claim(model, await estimateBytes(model))
    void reconcile()
  } catch (error) {
    if (current()) {
      loadedFor.delete(model)
      releaseMemory(owner(model))
      status.set(signal?.aborted ? { state: "idle" } : { state: "error", message: errorText(error) })
    }
    throw error
  } finally {
    const left = (loads.get(model) ?? 1) - 1
    if (left > 0) loads.set(model, left)
    else loads.delete(model)
  }
}

/**
 * Loads a model ahead of time (downloading it the first time) for chats of
 * up to `contextLength` tokens: the model's own context length by default.
 * A different context length loads the model again. Other models stay
 * loaded while they fit the memory budget.
 */
export function loadModel(model: WebGlTextModel, contextLength?: number): Promise<void> {
  const promise = ensureModel(model, contextLength)
  // Callers may not wait for it: the status store reports a failure too.
  promise.catch(() => undefined)
  return promise
}

/**
 * The model loaded for `contextLength` (as requested), loading it if it
 * isn't: what each adapter call waits for before its request.
 */
export async function ensureModel(
  model: WebGlTextModel,
  contextLength: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  if (
    modelStatus(model).get().state === "ready" &&
    loadedFor.has(model) &&
    loadedFor.get(model) === contextLength
  ) {
    touchMemory(owner(model))
    return
  }
  await load(model, contextLength, signal)
}

/** Marks `model` as just used, for least recently used order across runtimes. */
export function touchModel(model: WebGlTextModel) {
  touchMemory(owner(model))
}

/**
 * Unloads `model`, or every model, freeing its GPU memory; a running
 * generation of it fails. Never rejects (callers often don't wait for it).
 */
export function unloadModel(model?: WebGlTextModel): Promise<void> {
  for (const name of model === undefined ? [...statuses.keys()] : [model]) forget(name)
  return webgllm.unloadModel(model).catch(() => undefined)
}

/**
 * Brings ready statuses in line with what webgllm holds: its own budget
 * may unload a model to make room (as a cache grows, say) and a worker may
 * crash, and neither is announced. Run after loads and generations.
 */
export async function reconcile(): Promise<void> {
  const ready = [...statuses].filter(([, status]) => status.get().state === "ready")
  await Promise.all(
    ready.map(async ([model]) => {
      const epoch = epochs.get(model) ?? 0
      const loaded = await webgllm.models.retrieve(model).then(
        (info) => info.loaded,
        () => true
      )
      if (!loaded && (epochs.get(model) ?? 0) === epoch && !loads.has(model)) forget(model)
    })
  )
}

/** Watches a load this module didn't start (a completion loading its model on demand). */
const watched = new Map<string, { lastProgress: number }>()
/** How long without progress before a watched load counts as over (it failed, or was a download only). */
const WATCH_TIMEOUT_MS = 15_000
const WATCH_INTERVAL_MS = 1_000

function watch(model: string) {
  const known = watched.get(model)
  if (known) {
    known.lastProgress = Date.now()
    return
  }
  const entry = { lastProgress: Date.now() }
  watched.set(model, entry)
  const epoch = epochs.get(model) ?? 0
  const tick = async () => {
    const status = modelStatus(model)
    const stillOurs = (epochs.get(model) ?? 0) === epoch && !loads.has(model) && status.get().state === "loading"
    if (!stillOurs) {
      watched.delete(model)
      return
    }
    const info = await webgllm.models.retrieve(model).catch(() => undefined)
    if (info?.loaded) {
      watched.delete(model)
      loadedFor.set(model, info.loadedContextLength)
      status.set({ state: "ready" })
      void claim(model, Math.round(info.size * TEXTURES_PER_FILE_BYTE))
      return
    }
    if (Date.now() - entry.lastProgress > WATCH_TIMEOUT_MS) {
      watched.delete(model)
      if (status.get().state === "loading") status.set({ state: "idle" })
      return
    }
    setTimeout(() => void tick(), WATCH_INTERVAL_MS)
  }
  setTimeout(() => void tick(), WATCH_INTERVAL_MS)
}

/**
 * Every load's progress, however it started: loads this module runs, and
 * ones a completion starts on demand (which it then watches until ready).
 */
export function trackProgress(progress: LoadProgress) {
  const status = modelStatus(progress.model)
  status.set({
    state: "loading",
    progress: progress.progress,
    cached: progress.cached,
    ...(progress.totalBytes !== undefined && {
      loadedBytes: progress.loadedBytes ?? 0,
      totalBytes: progress.totalBytes
    })
  })
  if (!loads.has(progress.model)) watch(progress.model)
}

webgllm.addEventListener("progress", trackProgress)
