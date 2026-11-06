/**
 * The models webgllm runs, from its catalog, with their reasoning levels in
 * TanStack AI's shape (for `chat({ reasoning })` and
 * `supportedReasoningLevels()`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"
import { WEBGL_MODEL_META, WEBGL_TEXT_MODELS } from "webgllm/advanced"
import type { WebGlModelMeta, WebGlModelReasoning, WebGlTextModel } from "webgllm/advanced"

export { WEBGL_MODEL_META, WEBGL_TEXT_MODELS }
export type { WebGlModelMeta, WebGlTextModel }

/**
 * The reasoning levels of each model that thinks, exactly as its catalog
 * entry gives them: LFM3 and Qwen3.5 switch between `off` and `high`, the
 * LFM2.5 Thinking builds always think (`high` only). Models that don't think
 * aren't in it.
 */
export type WebGlModelReasoningByName = {
  [K in WebGlTextModel as WebGlModelReasoning<K> extends undefined ? never : K]: ModelReasoningCapability<
    NonNullable<WebGlModelReasoning<K>>
  >
}

/** Reasoning data of each model (`false`: it doesn't think), for `supportedReasoningLevels()`. */
export const WEBGL_MODEL_REASONING = Object.fromEntries(
  WEBGL_TEXT_MODELS.map((model) => [model, WEBGL_MODEL_META[model].reasoning ?? false])
) as Readonly<Record<WebGlTextModel, ModelReasoning>>

/** A model's catalog entry. */
export const modelMeta = (model: WebGlTextModel): WebGlModelMeta => WEBGL_MODEL_META[model]
