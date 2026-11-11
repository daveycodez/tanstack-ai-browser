/**
 * The models webgllm runs: webgllm's own catalog, re-exported under this
 * adapter's names, with their reasoning levels in TanStack AI's shape (for
 * `chat({ reasoning })` and `supportedReasoningLevels()`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"
import { WEBGL_MODEL_META, WEBGL_TEXT_MODELS } from "webgllm"
import type { WebGlModelMeta, WebGlModelReasoning, WebGlTextModel } from "webgllm"

// webgllm's catalog as it is: the models it runs, and each one's entry by name.
export { WEBGL_TEXT_MODELS as WEBGLLM_CHAT_MODELS, WEBGL_MODEL_META as WEBGLLM_MODEL_META } from "webgllm"
export type { WebGlTextModel as WebGllmChatModel, WebGlModelMeta as WebGllmModelMeta } from "webgllm"

type WebGllmChatModel = WebGlTextModel

/**
 * The reasoning levels of each model that thinks, exactly as its catalog
 * entry gives them: LFM3 and Qwen3.5 switch between `off` and `high`, the
 * LFM2.5 Thinking builds always think (`high` only). Models that don't think
 * aren't in it.
 */
export type WebGllmModelReasoningByName = {
  [K in WebGllmChatModel as WebGlModelReasoning<K> extends undefined ? never : K]: ModelReasoningCapability<
    NonNullable<WebGlModelReasoning<K>>
  >
}

/** Reasoning data of each model (`false`: it doesn't think), for `supportedReasoningLevels()`. */
export const WEBGLLM_MODEL_REASONING = Object.fromEntries(
  WEBGL_TEXT_MODELS.map((model) => [model, WEBGL_MODEL_META[model].reasoning ?? false])
) as Readonly<Record<WebGllmChatModel, ModelReasoning>>

/** A model's catalog entry. */
export const modelMeta = (model: WebGllmChatModel): WebGlModelMeta => WEBGL_MODEL_META[model]
