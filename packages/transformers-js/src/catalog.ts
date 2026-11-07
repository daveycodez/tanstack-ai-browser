/**
 * The models this package knows: Hugging Face ONNX builds that run in the
 * browser, with what each supports, the sampling from its card, and how it
 * writes tool calls. Any other Hugging Face id works too (see
 * `transformersJsText`), with the on/off reasoning toggle.
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

import type { WeightsDtype } from "./protocol.js"

/**
 * Sampling from a model's card, in `modelOptions`' names (OpenRouter's
 * convention): used unless a call's `modelOptions` overrides it.
 */
export type Sampling = {
  temperature: number
  topK: number
  repetitionPenalty: number
  /** Nucleus sampling: the likeliest tokens up to this probability. */
  topP?: number
}
import type { ToolFormat } from "./tool-calls.js"

export type TransformersJsModelMeta = {
  /** The Hugging Face model id. */
  name: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Parameter count. */
  size: string
  /** Reasoning levels for `chat({ reasoning })`, read from the chat template. */
  reasoning?: ModelReasoning
  /** How the model writes tool calls. */
  toolFormat: ToolFormat
  /** The weights to load: "q4f16" unless the model needs fp32 activations. */
  dtype?: WeightsDtype
  /**
   * The repo also has q4 weights (float32 activations) that run on the CPU
   * through WebAssembly where there's no WebGPU. Not for q4 graphs whose
   * embedding is GatherBlockQuantized: the ONNX Runtime build Transformers.js
   * imports has no CPU kernel for it (microsoft/onnxruntime#33961).
   */
  cpu?: boolean
  /** Sampling from the model card, used unless `modelOptions` overrides it. */
  sampling: Sampling
}

// Reasoning shapes, each level's value being the chat template's
// `enable_thinking`. Read from the models' chat templates: LFM3's and
// Gemma 4's and Qwen3.5's take `enable_thinking`; LFM2.5 Thinking always
// thinks and takes no switch.
const THINKING_SWITCH = {
  levels: { off: "false", high: "true" },
  budget: true
} as const
const ALWAYS_THINKS = { levels: { high: "true" }, budget: true } as const


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

/** LFM2 1.2B Tool card: greedy decoding (temperature 0). */
const LFM2_TOOL_SAMPLING = {
  temperature: 0,
  topK: 1,
  repetitionPenalty: 1
} as const satisfies Sampling

/** LFM3 card, "General" (chat, tool use, agents, coding). */
const LFM3_SAMPLING = {
  temperature: 0.1,
  topK: 50,
  repetitionPenalty: 1.1
} as const satisfies Sampling
const LFM2_5_SAMPLING = {
  temperature: 0.1,
  topK: 50,
  repetitionPenalty: 1.05
} as const satisfies Sampling
const LFM2_5_THINKING_SAMPLING = {
  temperature: 0.05,
  topK: 50,
  repetitionPenalty: 1.05
} as const satisfies Sampling

/** Gemma 4's generation config: temperature 1, top-k 64, top-p 0.95. */
const GEMMA_4_SAMPLING = {
  temperature: 1,
  topK: 64,
  topP: 0.95,
  repetitionPenalty: 1
} as const satisfies Sampling

/**
 * Qwen3.5's generation config (the card's settings without a presence
 * penalty, which isn't supported here).
 */
const QWEN_3_5_SAMPLING = {
  temperature: 0.6,
  topK: 20,
  topP: 0.95,
  repetitionPenalty: 1
} as const satisfies Sampling

/**
 * Gemma 4 E4B (4.5B effective parameters, 8B with its per-layer
 * embeddings), in onnx-community's Transformers.js build; its text model
 * only (embedding and decoder, 4.9 GB).
 */
const GEMMA_4_E4B = {
  name: "onnx-community/gemma-4-E4B-it-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "4b",
  reasoning: THINKING_SWITCH,
  toolFormat: "gemma4",
  sampling: GEMMA_4_SAMPLING
} as const satisfies TransformersJsModelMeta

/**
 * LFM3 built for iPhone Safari: GPTQ 4-bit with block size 32 (so
 * onnxruntime-web's fast prompt kernel and fused kernels apply), a 48k
 * vocabulary, no embedding copy at load (900 MB of weights instead of
 * 1.09 GB), and flash attention in the sliding-window layers.
 */
const LFM3_1_7B_WEB = {
  name: "daveycodez/LFM3-1.7B-Web-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  toolFormat: "lfm3",
  sampling: LFM3_SAMPLING,
  cpu: true
} as const satisfies TransformersJsModelMeta

/** The onnx-community export of LFM3. */
const LFM3_1_7B = {
  name: "onnx-community/LFM3-1.7B-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  toolFormat: "lfm3",
  sampling: LFM3_SAMPLING
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B = {
  name: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
  supports: TOOLS,
  size: "1.2b",
  toolFormat: "lfm2",
  sampling: LFM2_5_SAMPLING
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B_THINKING = {
  name: "LiquidAI/LFM2.5-1.2B-Thinking-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS,
  toolFormat: "lfm2",
  sampling: LFM2_5_THINKING_SAMPLING
} as const satisfies TransformersJsModelMeta

/**
 * Liquid AI's LFM2 1.2B Tool, in onnx-community's build: tuned for short,
 * precise tool calls without thinking. Its q4 weights (1.2 GB) run on the
 * CPU too.
 */
const LFM2_1_2B_TOOL = {
  name: "onnx-community/LFM2-1.2B-Tool-ONNX",
  supports: TOOLS,
  size: "1.2b",
  toolFormat: "lfm2",
  sampling: LFM2_TOOL_SAMPLING,
  cpu: true
} as const satisfies TransformersJsModelMeta

/**
 * Liquid AI's LFM2.5 350M (instruction-tuned): the smallest and quickest,
 * for short answers, extraction and tool calls rather than knowledge or
 * code. Its graph already computes logits for the last token only.
 */
const LFM2_5_350M = {
  name: "LiquidAI/LFM2.5-350M-ONNX",
  supports: TOOLS,
  size: "350m",
  toolFormat: "lfm2",
  sampling: LFM2_5_SAMPLING
} as const satisfies TransformersJsModelMeta

/**
 * Qwen3.5 2B: linear-attention layers with a full-attention layer every
 * fourth, in onnx-community's build. Its text model only: the embedding and
 * decoder, 1.38 GB in q4f16. Thinking is off
 * unless turned on.
 */
const QWEN_3_5_2B = {
  name: "onnx-community/Qwen3.5-2B-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "2b",
  reasoning: THINKING_SWITCH,
  toolFormat: "qwen3.5",
  sampling: QWEN_3_5_SAMPLING
} as const satisfies TransformersJsModelMeta

/**
 * LiquidAI's LFM2.5 re-exported with a `num_logits_to_keep` input, so
 * reading a prompt computes logits for its last token only (an 800-token
 * prompt otherwise needs 210 MB for them, which crashed iPhone Safari).
 */
const LFM2_5_1_2B_WEB = {
  name: "daveycodez/LFM2.5-1.2B-Web-ONNX",
  supports: TOOLS,
  size: "1.2b",
  toolFormat: "lfm2",
  sampling: LFM2_5_SAMPLING,
  cpu: true
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B_THINKING_WEB = {
  name: "daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS,
  toolFormat: "lfm2",
  sampling: LFM2_5_THINKING_SAMPLING,
  cpu: true
} as const satisfies TransformersJsModelMeta

export const TRANSFORMERS_JS_CHAT_MODELS = [
  GEMMA_4_E4B.name,
  LFM3_1_7B_WEB.name,
  LFM3_1_7B.name,
  LFM2_5_1_2B_WEB.name,
  LFM2_5_1_2B_THINKING_WEB.name,
  LFM2_5_1_2B.name,
  LFM2_5_1_2B_THINKING.name,
  LFM2_1_2B_TOOL.name,
  LFM2_5_350M.name,
  QWEN_3_5_2B.name
] as const

/** A model this package lists. */
export type TransformersJsChatModel =
  (typeof TRANSFORMERS_JS_CHAT_MODELS)[number]

/** Each listed model's metadata, by name. */
export const TRANSFORMERS_JS_MODEL_META: Readonly<
  Record<TransformersJsChatModel, TransformersJsModelMeta>
> = {
  [GEMMA_4_E4B.name]: GEMMA_4_E4B,
  [LFM3_1_7B_WEB.name]: LFM3_1_7B_WEB,
  [LFM3_1_7B.name]: LFM3_1_7B,
  [LFM2_5_1_2B_WEB.name]: LFM2_5_1_2B_WEB,
  [LFM2_5_1_2B_THINKING_WEB.name]: LFM2_5_1_2B_THINKING_WEB,
  [LFM2_5_1_2B.name]: LFM2_5_1_2B,
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING,
  [LFM2_1_2B_TOOL.name]: LFM2_1_2B_TOOL,
  [LFM2_5_350M.name]: LFM2_5_350M,
  [QWEN_3_5_2B.name]: QWEN_3_5_2B
}

const TRANSFORMERS_JS_REASONING = {
  [GEMMA_4_E4B.name]: GEMMA_4_E4B.reasoning,
  [LFM3_1_7B_WEB.name]: LFM3_1_7B_WEB.reasoning,
  [LFM3_1_7B.name]: LFM3_1_7B.reasoning,
  [LFM2_5_1_2B_THINKING_WEB.name]: LFM2_5_1_2B_THINKING_WEB.reasoning,
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING.reasoning,
  [QWEN_3_5_2B.name]: QWEN_3_5_2B.reasoning
} as const

/** The reasoning levels of each listed model that reasons. */
export type TransformersJsModelReasoningByName = {
  [K in keyof typeof TRANSFORMERS_JS_REASONING]: ModelReasoningCapability<
    (typeof TRANSFORMERS_JS_REASONING)[K]
  >
}

/**
 * Reasoning data of each listed model that reasons, for
 * `supportedReasoningLevels()`. A listed model missing here doesn't reason.
 */
export const TRANSFORMERS_JS_MODEL_REASONING: Readonly<
  Record<string, ModelReasoning>
> = TRANSFORMERS_JS_REASONING

/** The on/off toggle for a model this package doesn't list. */
export const UNLISTED_MODEL_REASONING: ModelReasoning = THINKING_SWITCH

const LISTED: ReadonlySet<string> = new Set(TRANSFORMERS_JS_CHAT_MODELS)

/** A listed model's metadata, or undefined for any other id. */
export const modelMeta = (
  model: string
): TransformersJsModelMeta | undefined =>
  LISTED.has(model)
    ? TRANSFORMERS_JS_MODEL_META[model as TransformersJsChatModel]
    : undefined

/**
 * Whether a model runs without WebGPU, on the CPU: a listed model that has
 * q4 weights. Another Hugging Face id may too; it isn't known here, so the
 * answer is yes, and loading says if its repo has no q4 weights.
 */
export const runsWithoutWebGpu = (model: string): boolean =>
  LISTED.has(model) ? (modelMeta(model)?.cpu ?? false) : true

/** A model's reasoning data: listed, none for a listed non-reasoner, else the toggle. */
export const modelReasoning = (model: string): ModelReasoning | undefined =>
  TRANSFORMERS_JS_MODEL_REASONING[model] ??
  (LISTED.has(model) ? undefined : UNLISTED_MODEL_REASONING)

