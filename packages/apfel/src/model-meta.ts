/**
 * The models apfel serves: Apple's on-device Foundation Model, with what it
 * supports. It doesn't reason itself: its reasoning levels are the adapter's,
 * working notes drafted before each step's reply (see reasoning.ts).
 * It reads images on macOS 27 and later; on older macOS apfel gives it only
 * text read from the image.
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/** What a model apfel serves supports. */
export type ApfelModelMeta = {
  /** The model's id, as apfel lists it. */
  name: string
  supports: {
    input: ReadonlyArray<"text" | "image">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Reasoning levels for `chat({ reasoning })`: off, or working notes before each step's reply, with a token budget. */
  reasoning: { levels: { off: string; high: string }; budget: true }
}

const APPLE_FOUNDATION_MODEL = {
  name: "apple-foundationmodel",
  supports: {
    input: ["text", "image"],
    output: ["text"],
    capabilities: ["tools", "thinking"]
  },
  reasoning: { levels: { off: "off", high: "high" }, budget: true }
} as const satisfies ApfelModelMeta

/** The models apfel serves: Apple's on-device Foundation Model. */
export const APFEL_CHAT_MODELS = [APPLE_FOUNDATION_MODEL.name] as const

/** A model apfel serves. */
export type ApfelChatModel = (typeof APFEL_CHAT_MODELS)[number]

/** Each model's metadata, by name. */
export const APFEL_MODEL_META: Readonly<Record<ApfelChatModel, ApfelModelMeta>> = {
  [APPLE_FOUNDATION_MODEL.name]: APPLE_FOUNDATION_MODEL
}

/** Each model's reasoning levels: off and high, with a token budget. */
export type ApfelModelReasoningByName = {
  [APPLE_FOUNDATION_MODEL.name]: ModelReasoningCapability<typeof APPLE_FOUNDATION_MODEL.reasoning>
}

/** Reasoning data of each model, for `supportedReasoningLevels()`. */
export const APFEL_MODEL_REASONING: Readonly<Record<ApfelChatModel, ModelReasoning>> = {
  [APPLE_FOUNDATION_MODEL.name]: APPLE_FOUNDATION_MODEL.reasoning
}
