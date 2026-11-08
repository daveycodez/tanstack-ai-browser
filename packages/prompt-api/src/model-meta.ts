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
  /**
   * Which model this browser provides, read when accessed. The Prompt API
   * doesn't say, but each browser has its own: Gemini Nano in Chrome,
   * Phi-4-mini in Edge. Read from the browser's brand (User-Agent Client
   * Hints), else its user agent.
   */
  readonly browserModel: {
    /** The model, where the browser tells it: by which browser this is. */
    id: "gemini-nano" | "phi-4-mini" | "unknown"
    /** "Gemini Nano", "Phi-4-mini", or "Built-in model". */
    name: string
    /** "Chrome", "Edge", or the browser's brand; null if it can't be told. */
    browser: string | null
  }
}

type BrowserModel = PromptApiModelMeta["browserModel"]

type NavigatorBrands = {
  userAgentData?: { brands?: Array<{ brand: string }> }
}

function browserModel(): BrowserModel {
  if (typeof navigator === "undefined") {
    return { id: "unknown", name: "Built-in model", browser: null }
  }
  const brands = ((navigator as NavigatorBrands).userAgentData?.brands ?? [])
    .map((b) => b.brand)
    .filter((b) => !/not.?a.?brand/i.test(b))
  const ua = navigator.userAgent
  if (brands.includes("Microsoft Edge") || /\bEdg\//.test(ua)) {
    return { id: "phi-4-mini", name: "Phi-4-mini", browser: "Edge" }
  }
  if (
    brands.includes("Google Chrome") ||
    (brands.length === 0 && /\bChrome\//.test(ua) && !/\bOPR\//.test(ua))
  ) {
    return { id: "gemini-nano", name: "Gemini Nano", browser: "Chrome" }
  }
  const brand = brands.find((b) => b !== "Chromium") ?? brands[0] ?? null
  return { id: "unknown", name: "Built-in model", browser: brand }
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
  reasoning: REASONING,
  get browserModel() {
    return browserModel()
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

const PROMPT_API_REASONING = { [BUILT_IN.name]: REASONING } as const

/** The model's reasoning levels: off and high, with a token budget. */
export type PromptApiModelReasoningByName = {
  [K in keyof typeof PROMPT_API_REASONING]: ModelReasoningCapability<(typeof PROMPT_API_REASONING)[K]>
}

/** Reasoning data of the model, for `supportedReasoningLevels()`. */
export const PROMPT_API_MODEL_REASONING: Readonly<Record<PromptApiChatModel, ModelReasoning>> =
  PROMPT_API_REASONING
