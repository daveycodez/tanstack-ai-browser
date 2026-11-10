/**
 * TanStack AI adapter for GGUF models that run in the browser with wllama
 * (llama.cpp in WebAssembly). The model catalog is in
 * `@tanstack-ai-browser/wllama/model-meta`.
 */
export { wllamaText, WllamaTextAdapter } from "./adapter.js"
export type { WllamaConfig, WllamaTextModelOptions } from "./adapter.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
