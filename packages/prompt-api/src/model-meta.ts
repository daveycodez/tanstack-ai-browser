/**
 * The model the Prompt API gives: the browser's own ("built-in"), Gemini
 * Nano in Chrome and Phi-4-mini in Edge, with what it supports and its
 * reasoning levels (emulated by the adapter: a draft of working notes before
 * the answer).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/** What the browser's model supports. */
export type PromptApiModelMeta = {
  /** The model's name for `promptApiText`: "built-in". */
  name: string
  supports: {
    input: ReadonlyArray<"text" | "image" | "audio">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Reasoning levels for `chat({ reasoning })`. */
  reasoning: { levels: { off: string; high: string }; budget: true }
}

const REASONING = {
  levels: { off: "off", high: "high" },
  budget: true
} as const

const BUILT_IN = {
  name: "built-in",
  supports: {
    input: ["text", "image", "audio"],
    output: ["text"],
    capabilities: ["tools", "thinking"]
  },
  reasoning: REASONING
} as const satisfies PromptApiModelMeta

/** The model: whichever one the browser provides. */
export const PROMPT_API_CHAT_MODELS = [BUILT_IN.name] as const

/** The model: whichever one the browser provides. */
export type PromptApiChatModel = (typeof PROMPT_API_CHAT_MODELS)[number]

/** The model's metadata, by name. */
export const PROMPT_API_MODEL_META: Readonly<Record<PromptApiChatModel, PromptApiModelMeta>> = {
  [BUILT_IN.name]: BUILT_IN
}

const PROMPT_API_REASONING = { [BUILT_IN.name]: REASONING } as const

/** The model's reasoning levels: off and high, with a token budget. */
export type PromptApiModelReasoningByName = {
  [K in keyof typeof PROMPT_API_REASONING]: ModelReasoningCapability<(typeof PROMPT_API_REASONING)[K]>
}

/** Reasoning data of the model, for `supportedReasoningLevels()`. */
export const PROMPT_API_MODEL_REASONING: Readonly<Record<PromptApiChatModel, ModelReasoning>> =
  PROMPT_API_REASONING
