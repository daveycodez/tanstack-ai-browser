/**
 * The runtime's public functions, the same as the other adapter packages':
 * whether it runs here, loading and unloading a model ahead of time, and
 * its loading status (from client.ts).
 */
import { loadModel as load } from "./client.js"
import type { WllamaChatModel } from "./catalog.js"

export { modelStatus, unloadModel } from "./client.js"
export type { ModelStatus } from "./client.js"

/**
 * Whether wllama can run `model` (any listed model) in this browser: llama.cpp
 * runs in WebAssembly in a Web Worker, on WebGPU where wllama can drive it and
 * on the CPU elsewhere, and wllama keeps models in the Origin Private File
 * System. So wherever the browser has WebAssembly, workers and OPFS (false on
 * a server).
 */
export function isSupported(model?: WllamaChatModel): boolean {
  void model
  return (
    typeof WebAssembly !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  )
}

/**
 * Loads a model (downloading it the first time), replacing any other. The
 * promise settles when it's ready to generate. Callers may leave it: a
 * failure is in `modelStatus(model)` too, so an unawaited rejection is
 * handled here.
 */
export function loadModel(model: WllamaChatModel): Promise<void> {
  const promise = load(model).then(() => undefined)
  promise.catch(() => undefined)
  return promise
}
