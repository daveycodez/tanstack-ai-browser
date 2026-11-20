/**
 * The model ML Kit's Prompt API runs: Gemini Nano, the on-device model that
 * Android's AICore keeps, with what it supports. Which Gemini Nano (2, 3 or
 * 4, "full" or "fast") depends on the device and the adapter's `releaseStage`
 * and `preference`: `variant()` says which, and `features()` what it can do
 * there (tools and thinking need a newer one).
 */
import type { ModelReasoning } from "@tanstack/ai"

/** What ML Kit's model supports. */
export type MlKitModelMeta = {
  /** The model's name for `mlkitText`: "gemini-nano". */
  name: string
  supports: {
    input: ReadonlyArray<"text" | "image">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "reasoning">
  }
  reasoning: ModelReasoning
}

/** Thinking mode's switch, as `chat()`'s reasoning levels: off, or on ("high"). */
const THINKING_SWITCH = { levels: { off: "false", high: "true" }, budget: false } as const satisfies ModelReasoning

const GEMINI_NANO = {
  name: "gemini-nano",
  supports: {
    input: ["text", "image"],
    output: ["text"],
    capabilities: ["tools", "reasoning"]
  },
  reasoning: THINKING_SWITCH
} as const satisfies MlKitModelMeta

/** The model: whichever Gemini Nano the device has. */
export const MLKIT_CHAT_MODELS = [GEMINI_NANO.name] as const

/** The model: whichever Gemini Nano the device has. */
export type MlKitChatModel = (typeof MLKIT_CHAT_MODELS)[number]

/** The model's metadata, by name. */
export const MLKIT_MODEL_META: Readonly<Record<MlKitChatModel, MlKitModelMeta>> = {
  [GEMINI_NANO.name]: GEMINI_NANO
}

/** The model's reasoning levels, by name: thinking mode off or on, where the device's model has it. */
export const MLKIT_MODEL_REASONING: Readonly<Record<MlKitChatModel, ModelReasoning>> = {
  [GEMINI_NANO.name]: GEMINI_NANO.reasoning
}
