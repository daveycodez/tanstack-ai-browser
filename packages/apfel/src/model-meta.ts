/**
 * The models apfel serves: Apple's on-device Foundation Model, with what it
 * supports. It doesn't reason, so `chat()` offers no `reasoning` option for it.
 */

/** What a model apfel serves supports. */
export type ApfelModelMeta = {
  /** The model's id, as apfel lists it. */
  name: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools">
  }
}

const APPLE_FOUNDATION_MODEL = {
  name: "apple-foundationmodel",
  supports: {
    input: ["text"],
    output: ["text"],
    capabilities: ["tools"]
  }
} as const satisfies ApfelModelMeta

/** The models apfel serves: Apple's on-device Foundation Model. */
export const APFEL_CHAT_MODELS = [APPLE_FOUNDATION_MODEL.name] as const

/** A model apfel serves. */
export type ApfelChatModel = (typeof APFEL_CHAT_MODELS)[number]

/** Each model's metadata, by name. */
export const APFEL_MODEL_META: Readonly<Record<ApfelChatModel, ApfelModelMeta>> = {
  [APPLE_FOUNDATION_MODEL.name]: APPLE_FOUNDATION_MODEL
}
