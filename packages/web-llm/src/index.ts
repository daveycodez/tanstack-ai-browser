/**
 * TanStack AI adapter for WebLLM: MLC's models in the browser on WebGPU, in
 * a Web Worker. The model catalog is in `@tanstack-ai-browser/web-llm/model-meta`.
 */
export { webLlmText, WebLlmTextAdapter } from "./adapter.js"
export type { WebLlmConfig, WebLlmModel, WebLlmTextModelOptions } from "./adapter.js"
export { webLlmEmbedding, WebLlmEmbeddingAdapter } from "./embedding.js"
export type { WebLlmEmbeddingConfig, WebLlmEmbeddingModelId, WebLlmEmbeddingModelOptions } from "./embedding.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
