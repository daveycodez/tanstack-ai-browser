/**
 * TanStack AI adapter for Apple's on-device Foundation Model, served by apfel.
 * The model catalog (model-meta.ts) is exported here too.
 */
export { apfelText } from "./adapter.js"
export type { ApfelConfig, ApfelModel, ApfelTextAdapter, ApfelTextModelOptions, Availability } from "./adapter.js"
export { APFEL_CHAT_MODELS, APFEL_MODEL_META } from "./model-meta.js"
export type { ApfelChatModel, ApfelModelMeta } from "./model-meta.js"
