/**
 * TanStack AI adapter for the browser's built-in language model, through
 * the Prompt API: Gemini Nano in Chrome, Phi-4-mini in Edge. The model
 * catalog (model-meta.ts) is exported here too.
 */
export { PromptApiTextAdapter, promptApiText } from "./adapter.js"
export type {
  PromptApiConfig,
  PromptApiTextModelOptions
} from "./adapter.js"
export type { Availability, DownloadProgressCallback } from "./types.js"
export * from "./model-meta.js"
