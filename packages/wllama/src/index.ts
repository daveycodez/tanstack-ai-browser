/**
 * TanStack AI adapter for GGUF models that run in the browser with wllama
 * (llama.cpp in WebAssembly). The model catalog (model-meta.ts) is exported
 * here too.
 */
export { wllamaText, WllamaTextAdapter } from "./adapter.js"
export type { WllamaConfig, WllamaTextModelOptions } from "./adapter.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
export type { WllamaModel } from "./catalog.js"
export * from "./model-meta.js"
