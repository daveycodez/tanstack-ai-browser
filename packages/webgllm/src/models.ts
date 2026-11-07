/**
 * The one `WebGLLM` instance every adapter and helper here shares, and the
 * page-side state around it: each model's loading status as a store, and
 * its place in the memory registry this project's runtimes share
 * (model-memory.ts), so a WebGL model and a Transformers.js or wllama one
 * make room for each other.
 */
import { WebGLLM } from "webgllm"
import { defaultMemoryBudget } from "webgllm/advanced"

import type { WebGllmChatModel } from "./catalog.js"
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
 * Whether this browser can run the engine (WebGL 2 with float render
 * targets, in a worker), so `model` (any model in the catalog).
 */
export async function isSupported(model?: WebGllmChatModel): Promise<boolean> {
  void model
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
export function modelStatus(model: WebGllmChatModel): Store<ModelStatus> {
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
export function setKeepLoaded(model: WebGllmChatModel, keep: boolean) {
  if (keep) keepLoaded.add(model)
  else keepLoaded.delete(model)
}

/** A model's name in the registry: webgllm holds several models, each its own entry. */
const owner = (model: string) => `webgllm:${model}`

/** The context each ready model was loaded for, as requested (undefined: the model's own). */
const loadedFor = new Map<string, number | undefined>()

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The registry unloads `model` to make room for another runtime's (or another webgllm model). */
function evict(model: string): Promise<void> {
  // webgllm's "unload" event then marks it idle and releases its claim.
  return webgllm.unloadModel(model).catch(() => undefined)
}

/**
 * Loads `model` for `contextLength`. Its memory is claimed from the worker
 * (see onMemoryClaim) and released at its "unload" event, and its status
 * follows webgllm's events (see below), not this function. Nothing is awaited
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
 * loaded while they fit the memory budget.
 */
export function loadModel(model: WebGllmChatModel, options: { contextLength?: number } = {}): Promise<void> {
  const promise = ensureModel(model, options.contextLength)
  // Callers may not wait for it: the status store reports a failure too.
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

// webgllm only dispatches events for models in its catalog, so `model` is a WebGllmChatModel.
// Statuses follow webgllm's lifecycle events, whatever started the load
// (loadModel, a completion loading on demand) or the unload (unloadModel,
// room for another model, a crash): set as they happen, as the
// Transformers.js and wllama runtimes set theirs.
webgllm.addEventListener("loadstart", ({ model }) => {
  const status = modelStatus(model as WebGllmChatModel)
  if (status.get().state !== "loading") status.set({ state: "loading", progress: 0, cached: true })
})

webgllm.addEventListener("progress", (progress) => {
  modelStatus(progress.model as WebGllmChatModel).set({
    state: "loading",
    progress: progress.progress,
    cached: progress.cached,
    ...(progress.totalBytes !== undefined && {
      loadedBytes: progress.loadedBytes ?? 0,
      totalBytes: progress.totalBytes
    })
  })
})

webgllm.addEventListener("load", ({ model }) => {
  modelStatus(model as WebGllmChatModel).set({ state: "ready" })
  touchMemory(owner(model))
})

webgllm.addEventListener("error", ({ model, error }) => {
  modelStatus(model as WebGllmChatModel).set({ state: "error", message: errorText(error) })
})

webgllm.addEventListener("unload", ({ model, reason }) => {
  loadedFor.delete(model)
  releaseMemory(owner(model))
  // After a failed load or a crash the status keeps the error.
  if (reason !== "failed" && reason !== "crashed") modelStatus(model as WebGllmChatModel).set({ state: "idle" })
})
