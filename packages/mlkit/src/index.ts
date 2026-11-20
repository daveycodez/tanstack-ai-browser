/**
 * TanStack AI adapter for Gemini Nano on Android, through ML Kit's GenAI
 * Prompt API (the model Android's AICore keeps), with its native tool
 * calling: a Capacitor plugin for Android (`MlKit`), or any host implementing
 * `MlKitNative`. The model catalog (model-meta.ts) is exported here too.
 */
export { MlKitTextAdapter, mlkitText } from "./adapter.js"
export type { Availability, DownloadProgressCallback, MlKitConfig, MlKitTextModelOptions } from "./adapter.js"
export { MlKit } from "./native.js"
export type {
  MlKitFeature,
  MlKitModelConfig,
  MlKitNative,
  NativeAvailability,
  NativeContent,
  NativeEvent,
  NativePart,
  NativeRequest,
  NativeSchema,
  NativeTool
} from "./native.js"
export { toNativeSchema } from "./schema.js"
export type { MlKitVariant } from "./variant.js"
export { MLKIT_CHAT_MODELS, MLKIT_MODEL_META, MLKIT_MODEL_REASONING } from "./model-meta.js"
export type { MlKitChatModel, MlKitModelMeta } from "./model-meta.js"
