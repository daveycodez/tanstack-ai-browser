/**
 * TanStack AI adapter for webgllm: LFM3, LFM2.5 and Qwen3.5 in the browser
 * on WebGL 2, for browsers without WebGPU (Firefox on Android, for one).
 * The model catalog is in `@tanstack-ai-browser/webgllm/model-meta`.
 */
export { webgllmText, WebGllmTextAdapter } from "./adapter.js"
export type { WebGllmConfig, WebGllmProviderUsageDetails, WebGllmTextModelOptions } from "./adapter.js"
export { isSupported, loadModel, modelStatus, setMemoryBudget, unloadModel } from "./models.js"
export type { ModelStatus, Store } from "./models.js"
