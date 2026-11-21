/**
 * TanStack AI adapters for webgllm: LFM3, LFM2.5 and Qwen3.5 (text), and
 * Tessera-small (16×16 pixel-art images), in the browser,
 * on WebGPU where the browser has it and WebGL 2 elsewhere (Firefox on
 * Android, for one). The model catalog (model-meta.ts) is exported here too.
 */
export { webgllmText, WebGllmTextAdapter } from "./adapter.js"
export type {
  Availability,
  DownloadProgressCallback,
  WebGllmBackend,
  WebGllmConfig,
  WebGllmModel,
  WebGllmPredictSpeedOptions,
  WebGllmTextModelOptions
} from "./adapter.js"
export type { SpeedPrediction } from "webgllm"
// webgllm's own worker handler, for a worker of your own (`worker` in the adapter's config).
export { WebGLLMWorkerHandler } from "webgllm"
export { WEBGLLM_CHAT_MODELS, WEBGLLM_MODEL_META, WEBGLLM_MODEL_REASONING } from "./catalog.js"
export type { WebGllmChatModel, WebGllmModelMeta, WebGllmModelReasoningByName } from "./catalog.js"
// Image generation (Tessera-small), on the same engine.
export { webgllmImage, WebGllmImageAdapter, WEBGLLM_IMAGE_MODEL_META, WEBGLLM_IMAGE_MODELS } from "./image-adapter.js"
export type {
  WebGllmImageConfig,
  WebGllmImageModel,
  WebGllmImageModelSizeByName,
  WebGllmImageProviderOptions
} from "./image-adapter.js"
