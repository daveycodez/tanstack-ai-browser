/**
 * TanStack AI adapter for Apple's on-device Foundation Model, through the
 * Foundation Models framework, with its native tool calling: a Capacitor
 * plugin for iOS (`Afm`), Electron's main process on macOS (`serveAfm()`), or
 * any host implementing `AfmNative`. The model catalog (model-meta.ts) is
 * exported here too.
 */
export { AfmTextAdapter, afmText } from "./adapter.js"
export type { Availability, AfmConfig, AfmTextModelOptions } from "./adapter.js"
export { Afm } from "./native.js"
export { serveAfm } from "./electron.js"
export type { ServeAfmOptions } from "./electron.js"
export type {
  AfmNative,
  NativeAvailability,
  NativeEvent,
  NativeGenerationSchema,
  NativeMessage,
  NativeProperty,
  NativeSchema,
  NativeTool,
  NativeUsage,
  UnavailableReason
} from "./native.js"
export { toNativeSchema } from "./schema.js"
export { AFM_CHAT_MODELS, AFM_MODEL_META } from "./model-meta.js"
export type { AfmChatModel, AfmModelMeta } from "./model-meta.js"
