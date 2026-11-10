/**
 * The models this package lists: Hugging Face ONNX builds that run in the
 * browser, with what each supports, its reasoning levels, whether it runs
 * on the CPU, and its card's sampling where its repo's
 * `generation_config.json` doesn't carry it (or carries other settings). Any other Hugging Face id works too (see
 * `transformersJsText`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

export type TransformersJsModelMeta = {
  /** The Hugging Face model id. */
  name: string
  supports: {
    /** Text, and images for a model whose repo has a vision encoder. */
    input: ReadonlyArray<"text" | "image">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "thinking">
  }
  /** Parameter count. */
  size: string
  /** Reasoning levels for `chat({ reasoning })`: each level's value is the chat template's `enable_thinking`. */
  reasoning?: ModelReasoning
  /**
   * The repo also has q4 weights (fp32 activations), which run on the CPU
   * through WebAssembly where there's no WebGPU.
   */
  cpu?: boolean
  /**
   * The model card's recommended sampling, for a repo whose
   * `generation_config.json` doesn't carry it (Transformers.js applies that
   * file's settings itself). `modelOptions` override it.
   */
  sampling?: Sampling
  /** The card's sampling while the chat template thinks, where it differs. */
  thinkingSampling?: Sampling
}

/** Sampling, as a model card recommends it, in Transformers.js's `generate()` settings (the names `modelOptions` takes). */
export type Sampling = {
  /** False is greedy decoding. */
  do_sample: boolean
  temperature?: number
  top_k?: number
  top_p?: number
  repetition_penalty?: number
}

/** LFM3's card ("General": chat, tool use, agents, coding). */
const LFM3_SAMPLING = { do_sample: true, temperature: 0.1, top_k: 50, repetition_penalty: 1.1 } as const satisfies Sampling
/** LFM2.5 Instruct's card. */
const LFM2_5_SAMPLING = { do_sample: true, temperature: 0.1, top_k: 50, repetition_penalty: 1.05 } as const satisfies Sampling
/** LFM2.5 Thinking's card. */
const LFM2_5_THINKING_SAMPLING = { do_sample: true, temperature: 0.05, top_k: 50, repetition_penalty: 1.05 } as const satisfies Sampling
/**
 * Qwen3.5's card, text tasks without thinking (its default). Its repo's
 * generation_config.json has the card's coding settings instead; the card's
 * presence penalty isn't in Transformers.js.
 */
const QWEN_3_5_SAMPLING = { do_sample: true, temperature: 1, top_k: 20, top_p: 1, repetition_penalty: 1 } as const satisfies Sampling
/** Qwen3.5's card, text tasks with thinking. */
const QWEN_3_5_THINKING_SAMPLING = { ...QWEN_3_5_SAMPLING, top_p: 0.95 } as const satisfies Sampling
/** LFM2 1.2B Tool's card: greedy decoding. */
const LFM2_TOOL_SAMPLING = { do_sample: false } as const satisfies Sampling

/** A chat template that takes `enable_thinking` (LFM3, Qwen3.5). */
const THINKING_SWITCH = { levels: { off: "false", high: "true" }, budget: false } as const
/** A model that always thinks (LFM2.5 Thinking): its template takes no switch. */
const ALWAYS_THINKS = { levels: { high: "true" }, budget: false } as const

const TOOLS_AND_THINKING = { input: ["text"], output: ["text"], capabilities: ["tools", "thinking"] } as const
const TOOLS = { input: ["text"], output: ["text"], capabilities: ["tools"] } as const
/** Qwen3.5: images too (its repos have a vision encoder), tools and thinking. */
const IMAGES_TOOLS_AND_THINKING = { input: ["text", "image"], output: ["text"], capabilities: ["tools", "thinking"] } as const

/** LFM3 built for the web: GPTQ 4-bit, a 48k vocabulary, flash attention in its sliding-window layers. */
const LFM3_1_7B_WEB = {
  name: "daveycodez/LFM3-1.7B-Web-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  cpu: true,
  sampling: LFM3_SAMPLING
} as const satisfies TransformersJsModelMeta

const LFM3_1_7B = {
  name: "onnx-community/LFM3-1.7B-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  sampling: LFM3_SAMPLING
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B = {
  name: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
  supports: TOOLS,
  size: "1.2b",
  sampling: LFM2_5_SAMPLING
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B_THINKING = {
  name: "LiquidAI/LFM2.5-1.2B-Thinking-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS,
  sampling: LFM2_5_THINKING_SAMPLING
} as const satisfies TransformersJsModelMeta

/** LFM2.5 re-exported to compute logits for a prompt's last token only. */
const LFM2_5_1_2B_WEB = {
  name: "daveycodez/LFM2.5-1.2B-Web-ONNX",
  supports: TOOLS,
  size: "1.2b",
  cpu: true,
  sampling: LFM2_5_SAMPLING
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B_THINKING_WEB = {
  name: "daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS,
  cpu: true,
  sampling: LFM2_5_THINKING_SAMPLING
} as const satisfies TransformersJsModelMeta

/** LFM2 1.2B Tool: short, precise tool calls without thinking. */
const LFM2_1_2B_TOOL = {
  name: "onnx-community/LFM2-1.2B-Tool-ONNX",
  supports: TOOLS,
  size: "1.2b",
  cpu: true,
  sampling: LFM2_TOOL_SAMPLING
} as const satisfies TransformersJsModelMeta

/** LFM2.5 350M: the smallest and quickest, for short answers and tool calls. */
const LFM2_5_350M = {
  name: "LiquidAI/LFM2.5-350M-ONNX",
  supports: TOOLS,
  size: "350m",
  sampling: LFM2_5_SAMPLING
} as const satisfies TransformersJsModelMeta

/**
 * Qwen3.5 2B: embedding and decoder, 1.38 GB in q4f16, and a 197 MB vision
 * encoder, loaded once a chat sends an image.
 */
const QWEN_3_5_2B = {
  name: "onnx-community/Qwen3.5-2B-ONNX",
  supports: IMAGES_TOOLS_AND_THINKING,
  size: "2b",
  reasoning: THINKING_SWITCH,
  sampling: QWEN_3_5_SAMPLING,
  thinkingSampling: QWEN_3_5_THINKING_SAMPLING
} as const satisfies TransformersJsModelMeta

/** Qwen3.5 0.8B: 584 MB in q4f16, and a 62 MB vision encoder, loaded once a chat sends an image. */
const QWEN_3_5_0_8B = {
  name: "onnx-community/Qwen3.5-0.8B-ONNX",
  supports: IMAGES_TOOLS_AND_THINKING,
  size: "0.8b",
  reasoning: THINKING_SWITCH,
  cpu: true,
  sampling: QWEN_3_5_SAMPLING,
  thinkingSampling: QWEN_3_5_THINKING_SAMPLING
} as const satisfies TransformersJsModelMeta

const MODELS = [
  LFM3_1_7B_WEB,
  LFM3_1_7B,
  LFM2_5_1_2B_WEB,
  LFM2_5_1_2B_THINKING_WEB,
  LFM2_5_1_2B,
  LFM2_5_1_2B_THINKING,
  LFM2_1_2B_TOOL,
  LFM2_5_350M,
  QWEN_3_5_2B,
  QWEN_3_5_0_8B
] as const

type Listed = (typeof MODELS)[number]

export const TRANSFORMERS_JS_CHAT_MODELS = MODELS.map((m) => m.name) as ReadonlyArray<Listed["name"]>

/** A model this package lists. */
export type TransformersJsChatModel = Listed["name"]

/** Each listed model's metadata, by name. */
export const TRANSFORMERS_JS_MODEL_META: Readonly<Record<TransformersJsChatModel, TransformersJsModelMeta>> = {
  [LFM3_1_7B_WEB.name]: LFM3_1_7B_WEB,
  [LFM3_1_7B.name]: LFM3_1_7B,
  [LFM2_5_1_2B_WEB.name]: LFM2_5_1_2B_WEB,
  [LFM2_5_1_2B_THINKING_WEB.name]: LFM2_5_1_2B_THINKING_WEB,
  [LFM2_5_1_2B.name]: LFM2_5_1_2B,
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING,
  [LFM2_1_2B_TOOL.name]: LFM2_1_2B_TOOL,
  [LFM2_5_350M.name]: LFM2_5_350M,
  [QWEN_3_5_2B.name]: QWEN_3_5_2B,
  [QWEN_3_5_0_8B.name]: QWEN_3_5_0_8B
}

type Reasoner = Extract<Listed, { reasoning: unknown }>

/** The reasoning levels of each listed model that reasons. */
export type TransformersJsModelReasoningByName = {
  [M in Reasoner as M["name"]]: ModelReasoningCapability<M["reasoning"]>
}

/** Reasoning data of each listed model that reasons. A listed model missing here doesn't reason. */
export const TRANSFORMERS_JS_MODEL_REASONING: Readonly<Record<string, ModelReasoning>> = Object.fromEntries(
  MODELS.flatMap((m) => ("reasoning" in m ? [[m.name, m.reasoning]] : []))
)
