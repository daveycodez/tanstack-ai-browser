/**
 * TanStack AI adapter for WebLLM: MLC's models in the browser on WebGPU, in
 * a Web Worker. The model catalog (model-meta.ts) is exported here too.
 */
export { webLlmText, WebLlmTextAdapter } from "./adapter.js"
export type { WebLlmConfig, WebLlmModel, WebLlmTextModelOptions } from "./adapter.js"
export { webLlmEmbedding, WebLlmEmbeddingAdapter } from "./embedding.js"
export type { WebLlmEmbeddingConfig, WebLlmEmbeddingModelId, WebLlmEmbeddingModelOptions } from "./embedding.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
// WebLLM's own worker handler, for a worker of your own (`worker` in the adapters' config).
export { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm"
export { WEB_LLM_CHAT_MODELS, WEB_LLM_EMBEDDING_MODELS, WEB_LLM_MODEL_REASONING } from "./catalog.js"
export type { WebLlmChatModel, WebLlmEmbeddingModel } from "./catalog.js"
// WebLLM's own catalog: every model's entry (`model_list`), as WebLLM has it.
export { prebuiltAppConfig } from "@mlc-ai/web-llm"
export type { AppConfig, ModelRecord } from "@mlc-ai/web-llm"
