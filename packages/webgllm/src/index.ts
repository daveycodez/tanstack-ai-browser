/**
 * TanStack AI adapter for webgllm: LFM3, LFM2.5 and Qwen3.5 in the browser
 * on WebGL 2, for browsers without WebGPU (Firefox on Android, for one).
 * The model catalog (model-meta.ts) is exported here too.
 */
export { webgllmText, WebGllmTextAdapter } from "./adapter.js"
export type { Availability, DownloadProgressCallback, WebGllmConfig, WebGllmModel, WebGllmTextModelOptions } from "./adapter.js"
// webgllm's own worker handler, for a worker of your own (`worker` in the adapter's config).
export { WebGLLMWorkerHandler } from "webgllm"
export { WEBGLLM_CHAT_MODELS, WEBGLLM_MODEL_META, WEBGLLM_MODEL_REASONING } from "./catalog.js"
export type { WebGllmChatModel, WebGllmModelMeta, WebGllmModelReasoningByName } from "./catalog.js"
