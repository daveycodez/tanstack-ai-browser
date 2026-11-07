/**
 * The models apfel serves: Apple's on-device Foundation Model, with what it
 * supports and its reasoning levels (emulated by the adapter: a draft of
 * working notes before the answer).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/** What a model apfel serves supports. */
export type ApfelModelMeta = {
  /** The model's id, as apfel lists it. */
  name: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Reasoning levels for `chat({ reasoning })`. */
  reasoning: { levels: { off: string; high: string }; budget: true }
}

const APPLE_FOUNDATION_MODEL = {
  name: "apple-foundationmodel",
  supports: {
    input: ["text"],
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

const APFEL_REASONING = {
  [APPLE_FOUNDATION_MODEL.name]: APPLE_FOUNDATION_MODEL.reasoning
} as const

/** The reasoning levels of each model: off and high, with a token budget. */
export type ApfelModelReasoningByName = {
  [K in keyof typeof APFEL_REASONING]: ModelReasoningCapability<(typeof APFEL_REASONING)[K]>
}

/** Reasoning data of each model, for `supportedReasoningLevels()`. */
export const APFEL_MODEL_REASONING: Readonly<Record<ApfelChatModel, ModelReasoning>> =
  APFEL_REASONING
