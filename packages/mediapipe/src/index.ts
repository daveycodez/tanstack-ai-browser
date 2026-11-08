/**
 * TanStack AI embedding adapter for Google's MediaPipe TextEmbedder, which
 * runs Universal Sentence Encoder in the browser. The model catalog is in
 * `@tanstack-ai-browser/mediapipe/model-meta`.
 */
export { MediaPipeEmbeddingAdapter, mediaPipeEmbedding } from "./adapter.js"
export type {
  MediaPipeEmbeddingConfig,
  MediaPipeEmbeddingProviderOptions
} from "./adapter.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
