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
 * runs in WebAssembly, on WebGPU where wllama can drive it and on the CPU
 * elsewhere, so wherever the browser has WebAssembly.
 */
export async function isSupported(model?: WllamaChatModel): Promise<boolean> {
  void model
  return typeof WebAssembly !== "undefined"
}

/**
 * Loads a model (downloading it the first time), replacing any other. The
 * promise settles when it's ready to generate.
 */
export async function loadModel(model: WllamaChatModel): Promise<void> {
  await load(model)
}
