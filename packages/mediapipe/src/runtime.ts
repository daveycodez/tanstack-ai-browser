/**
 * The runtime's public functions, the same as the other adapter packages':
 * whether it runs here, loading and unloading a model ahead of time, and
 * its loading status (from client.ts).
 */
import type { MediaPipeEmbeddingModel } from "./model-meta.js"

export { loadModel, modelStatus, unloadModel } from "./client.js"
export type { ModelStatus } from "./client.js"

/**
 * A WebAssembly module with one SIMD instruction: MediaPipe's WebAssembly
 * is built with SIMD and has no build without it.
 */
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
  253, 15, 253, 98, 11
])

/**
 * Whether MediaPipe can run `model` (any listed model) in this browser: its
 * TextEmbedder runs in WebAssembly with SIMD, in a module Web Worker. So
 * wherever the browser has those (false on a server).
 */
export function isSupported(model?: MediaPipeEmbeddingModel): boolean {
  void model
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") return false
  try {
    return WebAssembly.validate(SIMD_MODULE)
  } catch {
    return false
  }
}
