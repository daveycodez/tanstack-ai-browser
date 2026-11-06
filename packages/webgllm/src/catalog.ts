/**
 * The models webgllm runs, from its catalog, with their reasoning levels in
 * TanStack AI's shape (for `chat({ reasoning })` and
 * `supportedReasoningLevels()`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"
import { WEBGL_MODEL_META, WEBGL_TEXT_MODELS } from "webgllm/advanced"
import type { WebGlModelMeta, WebGlTextModel } from "webgllm/advanced"

export { WEBGL_MODEL_META, WEBGL_TEXT_MODELS }
export type { WebGlModelMeta, WebGlTextModel }

/** A model's thinking levels as the catalog gives them (the template's enable_thinking). */
type CatalogReasoning = NonNullable<WebGlModelMeta["reasoning"]>

/**
 * The reasoning levels of each model. The catalog's types don't keep each
 * model's own levels, so every model gets the catalog's: `off` and `high`,
 * with a budget. At run time a model that always thinks clamps `off` to `high`.
 */
export type WebGlModelReasoningByName = {
  [K in WebGlTextModel]: ModelReasoningCapability<CatalogReasoning>
}

/** Reasoning data of each model (`false`: it doesn't think), for `supportedReasoningLevels()`. */
export const WEBGL_MODEL_REASONING: Readonly<Record<WebGlTextModel, ModelReasoning>> =
  Object.fromEntries(
    WEBGL_TEXT_MODELS.map((model) => [model, WEBGL_MODEL_META[model].reasoning ?? false])
  )

/** A model's catalog entry. */
export const modelMeta = (model: WebGlTextModel): WebGlModelMeta => WEBGL_MODEL_META[model]
