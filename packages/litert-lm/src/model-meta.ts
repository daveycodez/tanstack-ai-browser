/**
 * The catalog: models this adapter is known to run, by their Hugging Face
 * repository, with what each supports. Any other `.litertlm` model that
 * LiteRT-LM's web runtime takes loads too, by its repository (`owner/name`),
 * a `hf://` URI, or the URL of its file: the catalog only holds what the
 * runtime doesn't say, such as whether a model thinks.
 */
import type { ModelReasoning } from "@tanstack/ai"

/** What a model supports. */
export type LiteRtLmModelMeta = {
  /** The model's Hugging Face repository, its name for `litertLmText`. */
  name: string
  /** The download: the file LiteRT-LM picks from the repository for the web. */
  size: string
  supports: {
    input: ReadonlyArray<"text">
    output: ReadonlyArray<"text">
    capabilities: ReadonlyArray<"tools" | "reasoning">
  }
  /** Thinking levels, for a model whose thinking can be switched. Left out: it doesn't think. */
  reasoning?: ModelReasoning
}

/**
 * Thinking's switch, as `chat()`'s reasoning levels: off, or on ("high").
 * The values are LiteRT-LM's `enable_thinking`, which the model's chat
 * template reads.
 */
export const THINKING_SWITCH = { levels: { off: "false", high: "true" }, budget: false } as const satisfies ModelReasoning

const GEMMA_4_E2B = {
  name: "litert-community/gemma-4-E2B-it-litert-lm",
  size: "2.34 GB",
  supports: { input: ["text"], output: ["text"], capabilities: ["tools", "reasoning"] },
  reasoning: THINKING_SWITCH
} as const satisfies LiteRtLmModelMeta

const GEMMA_4_E4B = {
  name: "litert-community/gemma-4-E4B-it-litert-lm",
  size: "3.31 GB",
  supports: { input: ["text"], output: ["text"], capabilities: ["tools", "reasoning"] },
  reasoning: THINKING_SWITCH
} as const satisfies LiteRtLmModelMeta

/**
 * KRAFTON's own bundle: a 4,096-token context, and answers without thinking.
 * No tools: LiteRT-LM's web runtime (0.19) hands this model's calls back as
 * text (`<tool_call>…`), not as calls.
 */
const RAON_1_NANO = {
  name: "KRAFTON/Raon-1-nano-litert-lm",
  size: "1.82 GB",
  supports: { input: ["text"], output: ["text"], capabilities: [] }
} as const satisfies LiteRtLmModelMeta

/** The catalog's models, by their Hugging Face repository. */
export const LITERT_LM_CHAT_MODELS = [GEMMA_4_E2B.name, GEMMA_4_E4B.name, RAON_1_NANO.name] as const

/** A model of the catalog. */
export type LiteRtLmChatModel = (typeof LITERT_LM_CHAT_MODELS)[number]

/** Each model's entry, by name. */
export const LITERT_LM_MODEL_META = {
  [GEMMA_4_E2B.name]: GEMMA_4_E2B,
  [GEMMA_4_E4B.name]: GEMMA_4_E4B,
  [RAON_1_NANO.name]: RAON_1_NANO
} as const satisfies Record<LiteRtLmChatModel, LiteRtLmModelMeta>

/** Reasoning data of each model (`false`: it doesn't think), for `supportedReasoningLevels()`. */
export const LITERT_LM_MODEL_REASONING: Readonly<Record<LiteRtLmChatModel, ModelReasoning>> = {
  [GEMMA_4_E2B.name]: GEMMA_4_E2B.reasoning,
  [GEMMA_4_E4B.name]: GEMMA_4_E4B.reasoning,
  [RAON_1_NANO.name]: false
}

/** Whether the catalog lists a model. */
export const listed = (model: string): model is LiteRtLmChatModel => Object.prototype.hasOwnProperty.call(LITERT_LM_MODEL_META, model)
