/**
 * The models this package knows: GGUF files on Hugging Face that run on the
 * CPU with wllama, with what each supports, the sampling from its card, and
 * how it writes tool calls.
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

/**
 * Sampling settings from a model's card, in llama.cpp's request fields (the
 * names `modelOptions` takes): used unless a call's `modelOptions` sets them.
 */
export type Sampling = {
  temperature: number
  top_k: number
  /** llama.cpp's repetition penalty (`--repeat-penalty`). */
  repeat_penalty: number
  /** Nucleus sampling: the likeliest tokens up to this probability. */
  top_p?: number
  /** Drops tokens less likely than this share of the likeliest one's odds. */
  min_p?: number
  /** Lowers the odds of tokens that have appeared at all. */
  presence_penalty?: number
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
  /** The card's sampling while the chat template thinks, where it differs. */
  thinkingSampling?: Sampling
}

// Reasoning shapes, each level's value being the chat template's
// `enable_thinking`. Qwen3.5's template takes it (thinking off by default);
// LFM2.5 Thinking always thinks and takes no switch.
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

/** The cards' llama.cpp settings: `--temp 0.1 --top-k 50 --repeat-penalty 1.05`. */
const LFM2_5_SAMPLING = {
  temperature: 0.1,
  top_k: 50,
  repeat_penalty: 1.05
} as const satisfies Sampling
/** LFM2.5 Thinking's card: `--temp 0.05 --top-k 50 --repeat-penalty 1.05`. */
const LFM2_5_THINKING_SAMPLING = {
  temperature: 0.05,
  top_k: 50,
  repeat_penalty: 1.05
} as const satisfies Sampling

/** Qwen3.5's card, text tasks without thinking (its default). */
const QWEN_3_5_SAMPLING = {
  temperature: 1,
  top_k: 20,
  top_p: 1,
  min_p: 0,
  presence_penalty: 2,
  repeat_penalty: 1
} as const satisfies Sampling
/** Qwen3.5's card, text tasks with thinking. */
const QWEN_3_5_THINKING_SAMPLING = { ...QWEN_3_5_SAMPLING, top_p: 0.95, presence_penalty: 1.5 } as const satisfies Sampling

// Liquid's models are Q4_K_M: in wllama's WebAssembly build it reads
// prompts and writes tokens about three times as fast as Q4_0 (llama.cpp
// has no WebAssembly SIMD kernel for Q4_0 to match its Q4_K one), and
// faster than Q5_K_M, Q6_K and Q8_0, at 5% more size than Q4_0. LFM2.5
// 1.2B on an M3 Ultra, 24 threads: Q4_K_M 231 prompt tokens/s and 112
// tokens/s, Q4_0 (Liquid's QAD build too) 65 and 45.

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

/**
 * Qwen3.5 2B, in Unsloth's GGUF build (Qwen publishes none): linear-attention
 * layers with a full-attention layer every fourth, so the attention cache
 * stays small. Thinking is off unless turned on. Q4_K_M, as Liquid's: 1.28
 * GB.
 */
const QWEN_3_5_2B = {
  name: "unsloth/Qwen3.5-2B-GGUF",
  file: "Qwen3.5-2B-Q4_K_M.gguf",
  supports: TOOLS_AND_THINKING,
  size: "2b",
  reasoning: THINKING_SWITCH,
  sampling: QWEN_3_5_SAMPLING,
  thinkingSampling: QWEN_3_5_THINKING_SAMPLING
} as const satisfies WllamaModelMeta

export const WLLAMA_CHAT_MODELS = [
  LFM2_5_1_2B.name,
  LFM2_5_1_2B_THINKING.name,
  LFM2_5_350M.name,
  QWEN_3_5_2B.name
] as const

/** A model this package lists. */
export type WllamaChatModel = (typeof WLLAMA_CHAT_MODELS)[number]

/** Each listed model's metadata, by name. */
export const WLLAMA_MODEL_META: Readonly<
  Record<WllamaChatModel, WllamaModelMeta>
> = {
  [LFM2_5_1_2B.name]: LFM2_5_1_2B,
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING,
  [LFM2_5_350M.name]: LFM2_5_350M,
  [QWEN_3_5_2B.name]: QWEN_3_5_2B
}

const WLLAMA_REASONING = {
  [LFM2_5_1_2B_THINKING.name]: LFM2_5_1_2B_THINKING.reasoning,
  [QWEN_3_5_2B.name]: QWEN_3_5_2B.reasoning
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
export const modelMeta = (model: WllamaChatModel): WllamaModelMeta =>
  WLLAMA_MODEL_META[model]

/** A model the catalog lists, a GGUF file's URL, or a GGUF file on Hugging Face as `owner/repo/file.gguf`. */
export type WllamaModel = WllamaChatModel | (string & {})

/** Whether the catalog lists `model`. */
export const listed = (model: string): model is WllamaChatModel =>
  Object.prototype.hasOwnProperty.call(WLLAMA_MODEL_META, model)

/**
 * Where a model's GGUF file downloads from: a listed model's file, or the
 * named one, at its latest version (main) on Hugging Face.
 */
export const modelUrl = (model: WllamaModel) => {
  if (listed(model)) {
    const { name, file } = modelMeta(model)
    return `https://huggingface.co/${name}/resolve/main/${file}`
  }
  if (/^https?:\/\//.test(model)) return model
  const [owner, repo, ...path] = model.split("/")
  if (!owner || !repo || path.length === 0 || !model.endsWith(".gguf")) {
    throw new Error(`${model} isn't a model this package lists: name its GGUF file, as "owner/repo/file.gguf" or a URL.`)
  }
  return `https://huggingface.co/${owner}/${repo}/resolve/main/${path.join("/")}`
}
