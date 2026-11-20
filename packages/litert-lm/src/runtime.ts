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
  /** Resolves a `hf://` URI to its file's URL at the revision's commit, without downloading it. */
  resolveModel(model: string, options?: { signal?: AbortSignal }): Promise<{ model: unknown }>
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

/** The page's engine: the model it was made for (`key`), and the engine once it's loaded. */
export type Loaded = { key: string; engine: Promise<RuntimeEngine> }

let current: Loaded | undefined

/** The page's engine, if one is loaded or loading. */
export const currentEngine = () => current

/**
 * The page's engine for `key`: the one loaded, if it was made for it, else a
 * new one from `create`, made after the engine before it is deleted. A load
 * that fails leaves the page with no engine.
 */
export function engineFor(key: string, create: () => Promise<RuntimeEngine>): Loaded {
  if (current?.key === key) return current
  const before = current
  const loaded: Loaded = {
    key,
    engine: (async () => {
      if (before) await before.engine.then((engine) => engine.delete()).catch(() => undefined)
      return create()
    })()
  }
  current = loaded
  loaded.engine.catch(() => {
    if (current === loaded) current = undefined
  })
  return loaded
}

/** Deletes the page's engine if it's `loaded`. */
export async function releaseEngine(loaded: Loaded): Promise<void> {
  if (current !== loaded) return
  current = undefined
  await loaded.engine.then((engine) => engine.delete()).catch(() => undefined)
}
