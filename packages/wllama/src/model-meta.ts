/**
 * The models this package knows: GGUF files on Hugging Face that run on the
 * CPU with wllama, with what each supports, the sampling from its card, and
 * how it writes tool calls.
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/** Sampling settings from a model's card, as llama.cpp takes them. */
export type Sampling = {
  temperature: number
  top_k: number
  /** llama.cpp's repetition penalty (`--repeat-penalty`). */
  repeat_penalty: number
  /** Nucleus sampling: the likeliest tokens up to this probability. */
  top_p?: number
}

export type WllamaModelMeta = {
  /** The Hugging Face repository the GGUF file is in. */
  name: string
  /** The GGUF file in the repository. */
  file: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Parameter count. */
  size: string
  /** Reasoning levels for `chat({ reasoning })`, read from the chat template. */
  reasoning?: ModelReasoning
  /** Sampling from the model card, used unless `modelOptions` overrides it. */
  sampling: Sampling
}

// Reasoning shapes, each level's value being the chat template's
// `enable_thinking`. LFM3's template takes it (thinking by default);
// LFM2.5 Thinking always thinks and takes no switch.
const THINKING_SWITCH = {
  levels: { off: "false", high: "true" },
  budget: false
} as const
const ALWAYS_THINKS = { levels: { high: "true" }, budget: false } as const

const TOOLS_AND_THINKING = {
  input: ["text"],
  output: ["text"],
  capabilities: ["tools", "thinking"]
} as const
const TOOLS = {
  input: ["text"],
  output: ["text"],
  capabilities: ["tools"]
} as const

/** The cards' llama.cpp settings: `--temp 0.1 --top-k 50 --repeat-penalty 1.05`. */
const LFM2_5_SAMPLING = {
  temperature: 0.1,
  top_k: 50,
  repeat_penalty: 1.05
} as const satisfies Sampling
/** LFM3's card: `--temp 0.1 --top-k 50 --repeat-penalty 1.1`. */
const LFM3_SAMPLING = {
  temperature: 0.1,
  top_k: 50,
  repeat_penalty: 1.1
} as const satisfies Sampling
/** LFM2.5 Thinking's card: `--temp 0.05 --top-k 50 --repeat-penalty 1.05`. */
const LFM2_5_THINKING_SAMPLING = {
  temperature: 0.05,
  top_k: 50,
  repeat_penalty: 1.05
} as const satisfies Sampling

// Liquid's models are Q4_K_M: in wllama's WebAssembly build it reads
// prompts and writes tokens about three times as fast as Q4_0 (llama.cpp
// has no WebAssembly SIMD kernel for Q4_0 to match its Q4_K one), and
// faster than Q5_K_M, Q6_K and Q8_0, at 5% more size than Q4_0. LFM2.5
// 1.2B on an M3 Ultra, 24 threads: Q4_K_M 231 prompt tokens/s and 112
// tokens/s, Q4_0 (Liquid's QAD build too) 65 and 45.

/**
 * Liquid AI's LFM3 1.7B, from its official GGUF repository: thinks by
 * default, or answers straight away with reasoning off. Runs on this
 * package's own builds of wllama, whose llama.cpp knows its architecture.
 */
const LFM3_1_7B = {
  name: "LiquidAI/LFM3-1.7B-GGUF",
  file: "LFM3-1.7B-Q4_K_M.gguf",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  sampling: LFM3_SAMPLING
} as const satisfies WllamaModelMeta

/**
 * LFM3 1.7B for the web: LFM3 with the smaller vocabulary of the
 * Transformers.js LFM3 Web build (49,152 tokens instead of 128,000), in
 * Q4_K with an importance matrix and the embedding / output layer in Q6_K.
 * 188 MB smaller than Liquid's Q4_K_M, it loads faster and writes about 6%
 * faster, with the same quality in English; other languages take 1.6-4.2
 * times as many tokens.
 */
const LFM3_1_7B_WEB = {
  name: "daveycodez/LFM3-1.7B-Web-GGUF",
  file: "LFM3-1.7B-Web-Q4_K.gguf",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  sampling: LFM3_SAMPLING
} as const satisfies WllamaModelMeta

/** Liquid AI's LFM2.5 1.2B Instruct, from its official GGUF repository. */
const LFM2_5_1_2B = {
  name: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
  file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
  supports: TOOLS,
  size: "1.2b",
  sampling: LFM2_5_SAMPLING
} as const satisfies WllamaModelMeta

/** LFM2.5 1.2B Thinking: thinks before every answer. */
const LFM2_5_1_2B_THINKING = {
  name: "LiquidAI/LFM2.5-1.2B-Thinking-GGUF",
  file: "LFM2.5-1.2B-Thinking-Q4_K_M.gguf",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS,
  sampling: LFM2_5_THINKING_SAMPLING
} as const satisfies WllamaModelMeta

/**
 * LFM2.5 350M: the smallest and quickest, for short answers, extraction and
 * tool calls rather than knowledge or code.
 */
const LFM2_5_350M = {
  name: "LiquidAI/LFM2.5-350M-GGUF",
  file: "LFM2.5-350M-Q4_K_M.gguf",
  supports: TOOLS,
  size: "350m",
  sampling: LFM2_5_SAMPLING
} as const satisfies WllamaModelMeta

export const WLLAMA_TEXT_MODELS = [
  LFM3_1_7B.name,
  LFM3_1_7B_WEB.name,
  LFM2_5_1_2B.name,
  LFM2_5_1_2B_THINKING.name,
  LFM2_5_350M.name
] as const

/** A model this package lists. */
export type WllamaTextModel = (typeof WLLAMA_TEXT_MODELS)[number]

/** Each listed model's metadata, by name. */
export const WLLAMA_MODEL_META: Readonly<
  Record<WllamaTextModel, WllamaModelMeta>
> = {
  [LFM3_1_7B.name]: LFM3_1_7B,
  [LFM3_1_7B_WEB.name]: LFM3_1_7B_WEB,
  [LFM2_5_1_2B.name]: LFM2_5_1_2B,
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING,
  [LFM2_5_350M.name]: LFM2_5_350M
}

const WLLAMA_REASONING = {
  [LFM3_1_7B.name]: LFM3_1_7B.reasoning,
  [LFM3_1_7B_WEB.name]: LFM3_1_7B_WEB.reasoning,
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING.reasoning
} as const

/** The reasoning levels of each listed model that reasons. */
export type WllamaModelReasoningByName = {
  [K in keyof typeof WLLAMA_REASONING]: ModelReasoningCapability<
    (typeof WLLAMA_REASONING)[K]
  >
}

/**
 * Reasoning data of each listed model that reasons, for
 * `supportedReasoningLevels()`. A model missing here doesn't reason.
 */
export const WLLAMA_MODEL_REASONING: Readonly<Record<string, ModelReasoning>> =
  WLLAMA_REASONING

/** A listed model's metadata. */
export const modelMeta = (model: WllamaTextModel): WllamaModelMeta =>
  WLLAMA_MODEL_META[model]

/** Where a model's GGUF file downloads from: its latest version (main) on Hugging Face. */
export const modelUrl = (model: WllamaTextModel) => {
  const { name, file } = modelMeta(model)
  return `https://huggingface.co/${name}/resolve/main/${file}`
}
