/**
 * The model the framework runs: Apple's system language model
 * (`SystemLanguageModel.default`), the on-device model of Apple Intelligence.
 * It calls tools natively, and holds structured answers to a schema. It doesn't
 * reason, so `chat()` offers no `reasoning` option for it.
 */

/** What a Foundation Models model supports. */
export type AfmModelMeta = {
  /** The model's name here. */
  name: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "structured-output">
  }
}

const SYSTEM_MODEL = {
  name: "system",
  supports: {
    input: ["text"],
    output: ["text"],
    capabilities: ["tools", "structured-output"]
  }
} as const satisfies AfmModelMeta

/** The models the framework runs: Apple's system language model. */
export const AFM_CHAT_MODELS = [SYSTEM_MODEL.name] as const

/** A model the framework runs. */
export type AfmChatModel = (typeof AFM_CHAT_MODELS)[number]

/** Each model's metadata, by name. */
export const AFM_MODEL_META: Readonly<Record<AfmChatModel, AfmModelMeta>> = {
  [SYSTEM_MODEL.name]: SYSTEM_MODEL
}
