/**
 * The models this package lists: Hugging Face ONNX builds that run in the
 * browser, with what each supports, its reasoning levels, whether it runs
 * on the CPU, and its card's sampling where its repo's
 * `generation_config.json` doesn't carry it (or carries other settings). Any other Hugging Face id works too (see
 * `transformersJsText`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

import type { DtypeByFile } from "./protocol.js"

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
   * A vision-language model: Transformers.js loads it only with its
   * processor and vision encoder, so the adapter does from the start.
   * (Qwen3.5 loads as a text model too, and takes its vision encoder once a
   * chat sends an image.)
   */
  vision?: boolean
  /** The weights of each of the repo's files on WebGPU, for a repo without a q4f16 set. */
  dtype?: DtypeByFile
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
/** LFM2.5-VL 450M's card. Its `min_p=0.15` isn't in Transformers.js. */
const LFM2_5_VL_SAMPLING = { do_sample: true, temperature: 0.1, repetition_penalty: 1.05 } as const satisfies Sampling
/** LFM2 1.2B Tool's card: greedy decoding. */
const LFM2_TOOL_SAMPLING = { do_sample: false } as const satisfies Sampling

/** A chat template that takes `enable_thinking` (LFM3, Qwen3.5). */
const THINKING_SWITCH = { levels: { off: "false", high: "true" }, budget: false } as const
/** A model that always thinks (LFM2.5 Thinking): its template takes no switch. */
const ALWAYS_THINKS = { levels: { high: "true" }, budget: false } as const

const TOOLS_AND_THINKING = { input: ["text"], output: ["text"], capabilities: ["tools", "thinking"] } as const
const TOOLS = { input: ["text"], output: ["text"], capabilities: ["tools"] } as const
/** LFM2.5-VL: images and tools. */
const IMAGES_AND_TOOLS = { input: ["text", "image"], output: ["text"], capabilities: ["tools"] } as const
/** Qwen3.5 and LFM3-VL: images too (their repos have a vision encoder), tools and thinking. */
const IMAGES_TOOLS_AND_THINKING = { input: ["text", "image"], output: ["text"], capabilities: ["tools", "thinking"] } as const

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

/**
 * LFM3-VL 2B: LFM3 with a vision encoder, thinking unless turned off.
 * Liquid's own ONNX repo isn't in Transformers.js's layout (it has no
 * `preprocessor_config.json`), so this is onnx-community's export of it: 1.3
 * GB in q4f16. Its `generation_config.json` carries the card's sampling.
 */
const LFM3_VL_2B = {
  name: "onnx-community/LFM3-VL-2B-ONNX",
  supports: IMAGES_TOOLS_AND_THINKING,
  size: "2b",
  reasoning: THINKING_SWITCH,
  vision: true
} as const satisfies TransformersJsModelMeta

/** Liquid's files for LFM2.5-VL: a q4 decoder, with the embedding and the vision encoder in fp16. */
const LFM2_5_VL_DTYPE = { decoder_model_merged: "q4", embed_tokens: "fp16", vision_encoder: "fp16" } as const

/**
 * LFM2.5-VL 3B, from Liquid's ONNX repository: 4 GB of files. Its
 * `generation_config.json` carries the card's sampling.
 */
const LFM2_5_VL_3B = {
  name: "LiquidAI/LFM2.5-VL-3B-ONNX",
  supports: IMAGES_AND_TOOLS,
  size: "3b",
  vision: true,
  dtype: LFM2_5_VL_DTYPE
} as const satisfies TransformersJsModelMeta

/** LFM2.5-VL 450M, from Liquid's ONNX repository: 0.8 GB of files. */
const LFM2_5_VL_450M = {
  name: "LiquidAI/LFM2.5-VL-450M-ONNX",
  supports: IMAGES_AND_TOOLS,
  size: "450m",
  vision: true,
  dtype: LFM2_5_VL_DTYPE,
  sampling: LFM2_5_VL_SAMPLING
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
  LFM3_1_7B,
  LFM3_VL_2B,
  LFM2_5_VL_3B,
  LFM2_5_VL_450M,
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
  [LFM3_1_7B.name]: LFM3_1_7B,
  [LFM3_VL_2B.name]: LFM3_VL_2B,
  [LFM2_5_VL_3B.name]: LFM2_5_VL_3B,
  [LFM2_5_VL_450M.name]: LFM2_5_VL_450M,
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
