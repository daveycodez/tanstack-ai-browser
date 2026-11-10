/**
 * TanStack AI adapter for Transformers.js models that run in the browser.
 * The model list is in `@tanstack-ai-browser/transformers-js/model-meta`.
 */
export { transformersJsText, TransformersJsTextAdapter } from "./adapter.js"
export type { TransformersJsConfig, TransformersJsTextModelOptions } from "./adapter.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
export { transformersJsEmbedding, TransformersJsEmbeddingAdapter } from "./embedding.js"
export type { TransformersJsEmbeddingConfig, TransformersJsEmbeddingModelOptions } from "./embedding.js"
export { transformersJsTranscription, TransformersJsTranscriptionAdapter } from "./transcription.js"
export type { TransformersJsTranscriptionConfig, TransformersJsTranscriptionModelOptions } from "./transcription.js"
// The handlers of the chat model and of Whisper, for a Web Worker of your own (`worker` in the adapters' config).
export { TransformersJsWorkerHandler } from "./handler.js"
export { TransformersJsTranscriptionWorkerHandler } from "./transcription-handler.js"
