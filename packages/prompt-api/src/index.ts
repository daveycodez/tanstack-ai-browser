/**
 * TanStack AI adapter for the browser's built-in language model, through
 * the Prompt API: Gemini Nano in Chrome, Phi-4-mini in Edge. The model
 * catalog is in `@tanstack-ai-browser/prompt-api/model-meta`.
 */
export { PromptApiTextAdapter, promptApiText } from "./adapter.js"
export type {
  PromptApiConfig,
  PromptApiProviderUsageDetails,
  PromptApiTextModelOptions
} from "./adapter.js"
export { isSupported, loadModel, modelStatus, unloadModel } from "./runtime.js"
export type { ModelStatus } from "./runtime.js"
export type { Store } from "./store.js"
