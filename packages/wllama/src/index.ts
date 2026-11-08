/**
 * TanStack AI adapter for GGUF models that run in the browser with wllama
 * (llama.cpp in WebAssembly). The model catalog is in
 * `@tanstack-ai-browser/wllama/model-meta`.
 */
export { wllamaText, WllamaTextAdapter } from "./adapter.js"
export type {
  WllamaConfig,
  WllamaProviderUsageDetails,
  WllamaTextModelOptions
} from "./adapter.js"
export {
  isSupported,
  loadModel,
  modelStatus,
  unloadModel
} from "./runtime.js"
export type { ModelStatus } from "./runtime.js"
export { setMemoryBudget } from "./model-memory.js"
export type { Store } from "./store.js"
