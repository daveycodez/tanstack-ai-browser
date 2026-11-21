/**
 * TanStack AI image adapter for ONNX models in the browser, on ONNX Runtime
 * Web (WebGPU, else WebAssembly). The model catalog (model-meta.ts) is
 * exported here too.
 */
export { MAX_IMAGES, OnnxImageAdapter, onnxImage } from "./adapter.js"
export type {
  Availability,
  DownloadProgressCallback,
  OnnxImageConfig,
  OnnxImageProviderOptions
} from "./adapter.js"
export { ONNX_IMAGE_MODELS, ONNX_MODEL_META } from "./model-meta.js"
export type { OnnxImageModel, OnnxImageModelMeta, OnnxImageModelSizeByName, OnnxModelFile } from "./model-meta.js"
export { DEFAULT_WASM_PATHS, ORT_VERSION } from "./runtime.js"
export type { OnnxBackend } from "./runtime.js"
export { MODEL_CACHE } from "./storage.js"
