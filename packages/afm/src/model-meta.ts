/**
 * The model the framework runs: Apple's system language model
 * (`SystemLanguageModel.default`), the on-device model of Apple Intelligence.
 * It calls tools natively, and holds structured answers to a schema. It doesn't
 * reason itself: its reasoning levels are the adapter's, working notes drafted
 * before each step's reply (see reasoning.ts).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/** What a Foundation Models model supports. */
export type AfmModelMeta = {
  /** The model's name here. */
  name: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "structured-output" | "thinking">
  }
  /** Reasoning levels for `chat({ reasoning })`: off, or working notes before each step's reply, with a token budget. */
  reasoning: { levels: { off: string; high: string }; budget: true }
}

const SYSTEM_MODEL = {
  name: "system",
  supports: {
    input: ["text"],
    output: ["text"],
    capabilities: ["tools", "structured-output", "thinking"]
  },
  reasoning: { levels: { off: "off", high: "high" }, budget: true }
} as const satisfies AfmModelMeta

/** The models the framework runs: Apple's system language model. */
export const AFM_CHAT_MODELS = [SYSTEM_MODEL.name] as const

/** A model the framework runs. */
export type AfmChatModel = (typeof AFM_CHAT_MODELS)[number]

/** Each model's metadata, by name. */
export const AFM_MODEL_META: Readonly<Record<AfmChatModel, AfmModelMeta>> = {
  [SYSTEM_MODEL.name]: SYSTEM_MODEL
}

/** Each model's reasoning levels: off and high, with a token budget. */
export type AfmModelReasoningByName = {
  [SYSTEM_MODEL.name]: ModelReasoningCapability<typeof SYSTEM_MODEL.reasoning>
}

/** Reasoning data of each model, for `supportedReasoningLevels()`. */
export const AFM_MODEL_REASONING: Readonly<Record<AfmChatModel, ModelReasoning>> = {
  [SYSTEM_MODEL.name]: SYSTEM_MODEL.reasoning
}
