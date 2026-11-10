/**
 * The model the Prompt API gives: the browser's own text model ("text", as other Prompt API libraries name it), Gemini
 * Nano in Chrome and Phi-4-mini in Edge, with what it supports.
 */

/** What the browser's model supports. */
export type PromptApiModelMeta = {
  /** The model's name for `promptApiText`: "text". */
  name: string
  supports: {
    input: ReadonlyArray<"text" | "image" | "audio">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools">
  }
}

const BUILT_IN = {
  name: "text",
  supports: {
    input: ["text", "image", "audio"],
    output: ["text"],
    capabilities: ["tools"]
  }
} as const satisfies PromptApiModelMeta

/** The model: whichever one the browser provides. */
export const PROMPT_API_CHAT_MODELS = [BUILT_IN.name] as const

/** The model: whichever one the browser provides. */
export type PromptApiChatModel = (typeof PROMPT_API_CHAT_MODELS)[number]

/** The model's metadata, by name. */
export const PROMPT_API_MODEL_META: Readonly<Record<PromptApiChatModel, PromptApiModelMeta>> = {
  [BUILT_IN.name]: BUILT_IN
}
