/**
 * TanStack AI adapter for Transformers.js models that run in the browser.
 * The model catalog is in `@tanstack-ai-browser/transformers-js/model-meta`.
 */
export { transformersJsText, TransformersJsTextAdapter } from "./adapter.js"
export type { TransformersJsConfig, TransformersJsTextModelOptions } from "./adapter.js"
export type { Availability, DownloadProgressCallback } from "./client.js"
