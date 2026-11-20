/**
 * LiteRT-LM's web runtime as the adapter uses it, and the page's engine.
 *
 * The runtime is the `@litert-lm/core` package, imported when a model first
 * loads (never on a server render). The types here are the parts of it the
 * adapter calls, so a host with its own build, or a test, can stand in.
 *
 * An engine holds a model on the GPU, so the page keeps one: loading another
 * model deletes the engine before it, and every conversation made on it.
 */
import type { ConversationConfig, EngineSettings, Message, MessageLike } from "@litert-lm/core"

/** A LiteRT-LM conversation: the calls the adapter makes on it. */
export type RuntimeConversation = {
  sendMessageStreaming(message: MessageLike): ReadableStream<Message>
  cancel(): void
  getBenchmarkInfo(): Promise<{ lastPrefillTokenCount: number; lastDecodeTokenCount: number }>
  delete(): Promise<void>
}

/** A LiteRT-LM engine: a loaded model. */
export type RuntimeEngine = {
  createConversation(config?: ConversationConfig): Promise<RuntimeConversation>
  delete(): Promise<void>
  /** The settings the engine resolved, its context length among them. */
  readonly settings?: { mainExecutorSettings?: { maxNumTokens?: number } }
}

/** The parts of `@litert-lm/core` the adapter uses. */
export type LiteRtLmRuntime = {
  Engine: { create(settings: EngineSettings): Promise<RuntimeEngine> }
  /**
   * Resolves a `hf://` URI to its file's URL at the revision's commit, without
   * downloading it: the file LiteRT-LM picks for `backend`, asked for with the
   * model's access token where it has one.
   */
  resolveModel(
    model: string | { url: string; accessToken?: string },
    options?: { backend?: NonNullable<EngineSettings["backend"]>; signal?: AbortSignal }
  ): Promise<{ model: unknown }>
  /** Loads the runtime's WASM from a folder, before the first engine. */
  loadLiteRtLm?(path: string): Promise<unknown>
}

let imported: Promise<LiteRtLmRuntime> | undefined

/** The `@litert-lm/core` package, imported once. */
export const defaultRuntime = (): Promise<LiteRtLmRuntime> =>
  (imported ??= import("@litert-lm/core").then(
    (core) => core as unknown as LiteRtLmRuntime,
    (error: unknown) => {
      imported = undefined
      throw error
    }
  ))

const runtimeIds = new WeakMap<object, number>()
let runtimes = 0

/** A number for a runtime given in place of the package (0 for the package itself): engines of different runtimes aren't shared. */
export function runtimeId(runtime: object | undefined): number {
  if (!runtime) return 0
  let id = runtimeIds.get(runtime)
  if (id === undefined) runtimeIds.set(runtime, (id = ++runtimes))
  return id
}

/** Hears a download's progress, 0 to 1. */
type ProgressListener = (progress: number) => void

/** The error of a wait that was stopped: the signal's reason, else an AbortError. */
export const abortError = (signal: AbortSignal | undefined): unknown => signal?.reason ?? new DOMException("Aborted", "AbortError")

/**
 * The page's engine: the model it was made for (`key`), and the engine once
 * it's loaded. A load is shared by everyone who asks for the same model
 * meanwhile: each waits for it on their own (`waitForEngine`), and it stops
 * only once none of them waits any more.
 */
export type Loaded = {
  key: string
  engine: Promise<RuntimeEngine>
  /** Stops the load. */
  readonly controller: AbortController
  /** Whether the load has ended, in an engine or a failure. */
  settled: boolean
  /** Callers waiting for the load now. */
  waiting: number
  /** Who hears the download's progress, each for as many waits as named it. */
  readonly listeners: Map<ProgressListener, number>
}

let current: Loaded | undefined

/** The page's engine, if one is loaded or loading. */
export const currentEngine = () => current

/**
 * The page's engine for `key`: the one loaded or loading, if it was made for
 * it, else a new one from `create`, made after the engine before it is
 * deleted. `create` gets the load's own signal, which aborts once nobody
 * waits for the load, and where to report the download's progress. A load
 * that fails leaves the page with no engine.
 */
export function engineFor(key: string, create: (signal: AbortSignal, report: ProgressListener) => Promise<RuntimeEngine>): Loaded {
  // (A load that was stopped is on its way out: nobody joins it.)
  if (current?.key === key && !current.controller.signal.aborted) return current
  const before = current
  const controller = new AbortController()
  const listeners = new Map<ProgressListener, number>()
  const load = async () => {
    if (before) await before.engine.then((engine) => engine.delete()).catch(() => undefined)
    controller.signal.throwIfAborted()
    return create(controller.signal, (progress) => {
      for (const listener of [...listeners.keys()]) listener(progress)
    })
  }
  const loaded: Loaded = { key, engine: load(), controller, settled: false, waiting: 0, listeners }
  current = loaded
  loaded.engine.then(
    () => {
      loaded.settled = true
    },
    () => {
      loaded.settled = true
      if (current === loaded) current = undefined
    }
  )
  return loaded
}

/**
 * A caller's wait for a load: the engine, or the caller's own stop
 * (`signal`), which leaves the load to the others waiting for it and stops
 * it if there are none. `listeners` hear the download's progress while the
 * caller waits.
 */
export function waitForEngine(loaded: Loaded, signal?: AbortSignal, listeners: ReadonlyArray<ProgressListener> = []): Promise<RuntimeEngine> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  loaded.waiting++
  for (const listener of listeners) loaded.listeners.set(listener, (loaded.listeners.get(listener) ?? 0) + 1)
  let left = false
  const leave = () => {
    if (left) return
    left = true
    loaded.waiting--
    for (const listener of listeners) {
      const waits = (loaded.listeners.get(listener) ?? 1) - 1
      if (waits > 0) loaded.listeners.set(listener, waits)
      else loaded.listeners.delete(listener)
    }
  }
  return new Promise<RuntimeEngine>((resolve, reject) => {
    const stop = () => {
      leave()
      if (!loaded.settled && loaded.waiting === 0) loaded.controller.abort(abortError(signal))
      reject(abortError(signal))
    }
    signal?.addEventListener("abort", stop, { once: true })
    loaded.engine.then(resolve, reject).finally(() => {
      signal?.removeEventListener("abort", stop)
      leave()
    })
  })
}

/** Deletes the page's engine if it's `loaded`. */
export async function releaseEngine(loaded: Loaded): Promise<void> {
  if (current !== loaded) return
  current = undefined
  await loaded.engine.then((engine) => engine.delete()).catch(() => undefined)
}
