/**
 * The model the Prompt API gives: the browser's own text model ("text", as other Prompt API libraries name it), Gemini
 * Nano in Chrome and Aion-1.1-Instruct in Edge, with what it supports and its
 * reasoning levels (the adapter's: working notes drafted before each step's
 * reply, see reasoning.ts).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/** What the browser's model supports. */
export type PromptApiModelMeta = {
  /** The model's name for `promptApiText`: "text". */
  name: string
  supports: {
    input: ReadonlyArray<"text" | "image" | "audio">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Reasoning levels for `chat({ reasoning })`: off, or working notes before each step's reply, with a token budget. */
  reasoning: { levels: { off: string; high: string }; budget: true }
}

const BUILT_IN = {
  name: "text",
  supports: {
    input: ["text", "image", "audio"],
    output: ["text"],
    capabilities: ["tools", "thinking"]
  },
  reasoning: { levels: { off: "off", high: "high" }, budget: true }
} as const satisfies PromptApiModelMeta

/** The model: whichever one the browser provides. */
export const PROMPT_API_CHAT_MODELS = [BUILT_IN.name] as const

/** The model: whichever one the browser provides. */
export type PromptApiChatModel = (typeof PROMPT_API_CHAT_MODELS)[number]

/** The model's metadata, by name. */
export const PROMPT_API_MODEL_META: Readonly<Record<PromptApiChatModel, PromptApiModelMeta>> = {
  [BUILT_IN.name]: BUILT_IN
}

/** The model's reasoning levels: off and high, with a token budget. */
export type PromptApiModelReasoningByName = {
  [BUILT_IN.name]: ModelReasoningCapability<typeof BUILT_IN.reasoning>
}

/** Reasoning data of the model, for `supportedReasoningLevels()`. */
export const PROMPT_API_MODEL_REASONING: Readonly<Record<PromptApiChatModel, ModelReasoning>> = {
  [BUILT_IN.name]: BUILT_IN.reasoning
}
