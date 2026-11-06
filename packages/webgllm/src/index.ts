/**
 * TanStack AI adapter for webgllm: LFM3, LFM2.5 and Qwen3.5 in the browser
 * on WebGL 2, for browsers without WebGPU (Firefox on Android, for one).
 */
export { webgllmText, WebGllmTextAdapter } from "./adapter.js"
export type { WebGllmTextConfig, WebGllmTextProviderOptions, WebGllmProviderUsageDetails } from "./adapter.js"
export { webgllm, isSupported, loadModel, unloadModel, modelStatus, setKeepLoaded, setMemoryBudget } from "./models.js"
export type { ModelStatus, Store } from "./models.js"
export { WEBGL_MODEL_META, WEBGL_TEXT_MODELS, WEBGL_MODEL_REASONING } from "./catalog.js"
export type { WebGlTextModel, WebGlModelMeta, WebGlModelReasoningByName } from "./catalog.js"
