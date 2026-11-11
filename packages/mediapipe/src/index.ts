/**
 * TanStack AI embedding adapter for Google's MediaPipe TextEmbedder, which
 * runs Universal Sentence Encoder in the browser. The model catalog
 * (model-meta.ts) is exported here too.
 */
export { MediaPipeEmbeddingAdapter, mediaPipeEmbedding } from "./adapter.js"
export type {
  Availability,
  MediaPipeEmbeddingConfig,
  MediaPipeEmbeddingProviderOptions
} from "./adapter.js"
export * from "./model-meta.js"
