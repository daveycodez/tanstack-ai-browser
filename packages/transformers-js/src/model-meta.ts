/**
 * The models this package lists: Hugging Face ONNX builds that run in the
 * browser, with what each supports, its reasoning levels, and whether it
 * runs on the CPU. Any other Hugging Face id works too (see
 * `transformersJsText`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"

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
  /** Reasoning levels for `chat({ reasoning })`: each level's value is the chat template's `enable_thinking`. */
  reasoning?: ModelReasoning
  /**
   * The repo also has q4 weights (fp32 activations), which run on the CPU
   * through WebAssembly where there's no WebGPU.
   */
  cpu?: boolean
}

/** A chat template that takes `enable_thinking` (LFM3, Gemma 4, Qwen3.5). */
const THINKING_SWITCH = { levels: { off: "false", high: "true" }, budget: false } as const
/** A model that always thinks (LFM2.5 Thinking): its template takes no switch. */
const ALWAYS_THINKS = { levels: { high: "true" }, budget: false } as const

const TOOLS_AND_THINKING = { input: ["text"], output: ["text"], capabilities: ["tools", "thinking"] } as const
const TOOLS = { input: ["text"], output: ["text"], capabilities: ["tools"] } as const

/** Gemma 4 E4B, its text model only (embedding and decoder, 4.9 GB). */
const GEMMA_4_E4B = {
  name: "onnx-community/gemma-4-E4B-it-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "4b",
  reasoning: THINKING_SWITCH
} as const satisfies TransformersJsModelMeta

/** LFM3 built for the web: GPTQ 4-bit, a 48k vocabulary, flash attention in its sliding-window layers. */
const LFM3_1_7B_WEB = {
  name: "daveycodez/LFM3-1.7B-Web-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH,
  cpu: true
} as const satisfies TransformersJsModelMeta

const LFM3_1_7B = {
  name: "onnx-community/LFM3-1.7B-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.7b",
  reasoning: THINKING_SWITCH
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B = {
  name: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
  supports: TOOLS,
  size: "1.2b"
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B_THINKING = {
  name: "LiquidAI/LFM2.5-1.2B-Thinking-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS
} as const satisfies TransformersJsModelMeta

/** LFM2.5 re-exported to compute logits for a prompt's last token only. */
const LFM2_5_1_2B_WEB = {
  name: "daveycodez/LFM2.5-1.2B-Web-ONNX",
  supports: TOOLS,
  size: "1.2b",
  cpu: true
} as const satisfies TransformersJsModelMeta

const LFM2_5_1_2B_THINKING_WEB = {
  name: "daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "1.2b",
  reasoning: ALWAYS_THINKS,
  cpu: true
} as const satisfies TransformersJsModelMeta

/** LFM2 1.2B Tool: short, precise tool calls without thinking. */
const LFM2_1_2B_TOOL = {
  name: "onnx-community/LFM2-1.2B-Tool-ONNX",
  supports: TOOLS,
  size: "1.2b",
  cpu: true
} as const satisfies TransformersJsModelMeta

/** LFM2.5 350M: the smallest and quickest, for short answers and tool calls. */
const LFM2_5_350M = {
  name: "LiquidAI/LFM2.5-350M-ONNX",
  supports: TOOLS,
  size: "350m"
} as const satisfies TransformersJsModelMeta

/** Qwen3.5 2B, its text model only (embedding and decoder, 1.38 GB in q4f16). */
const QWEN_3_5_2B = {
  name: "onnx-community/Qwen3.5-2B-ONNX",
  supports: TOOLS_AND_THINKING,
  size: "2b",
  reasoning: THINKING_SWITCH
} as const satisfies TransformersJsModelMeta

const MODELS = [
  GEMMA_4_E4B,
  LFM3_1_7B_WEB,
  LFM3_1_7B,
  LFM2_5_1_2B_WEB,
  LFM2_5_1_2B_THINKING_WEB,
  LFM2_5_1_2B,
  LFM2_5_1_2B_THINKING,
  LFM2_1_2B_TOOL,
  LFM2_5_350M,
  QWEN_3_5_2B
] as const

type Listed = (typeof MODELS)[number]

export const TRANSFORMERS_JS_CHAT_MODELS = MODELS.map((m) => m.name) as ReadonlyArray<Listed["name"]>

/** A model this package lists. */
export type TransformersJsChatModel = Listed["name"]

/** Each listed model's metadata, by name. */
export const TRANSFORMERS_JS_MODEL_META: Readonly<Record<TransformersJsChatModel, TransformersJsModelMeta>> = {
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

type Reasoner = Extract<Listed, { reasoning: unknown }>

/** The reasoning levels of each listed model that reasons. */
export type TransformersJsModelReasoningByName = {
  [M in Reasoner as M["name"]]: ModelReasoningCapability<M["reasoning"]>
}

/** Reasoning data of each listed model that reasons. A listed model missing here doesn't reason. */
export const TRANSFORMERS_JS_MODEL_REASONING: Readonly<Record<string, ModelReasoning>> = Object.fromEntries(
  MODELS.flatMap((m) => ("reasoning" in m ? [[m.name, m.reasoning]] : []))
)
