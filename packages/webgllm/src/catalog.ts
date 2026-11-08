/**
 * The models webgllm runs, from its catalog, with their reasoning levels in
 * TanStack AI's shape (for `chat({ reasoning })` and
 * `supportedReasoningLevels()`).
 */
import type { ModelReasoning } from "@tanstack/ai"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"
import { WEBGL_MODEL_META, WEBGL_TEXT_MODELS } from "webgllm/advanced"
import type { WebGlModelMeta, WebGlModelReasoning, WebGlTextModel } from "webgllm/advanced"

/** The models webgllm runs: its catalog's text models. */
export const WEBGLLM_CHAT_MODELS: typeof WEBGL_TEXT_MODELS = WEBGL_TEXT_MODELS

/** A model webgllm runs. */
export type WebGllmChatModel = WebGlTextModel

/** A model's catalog entry, as webgllm gives it. */
export type WebGllmModelMeta = WebGlModelMeta

/** Each model's catalog entry, by name. */
export const WEBGLLM_MODEL_META: typeof WEBGL_MODEL_META = WEBGL_MODEL_META

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
  WEBGLLM_CHAT_MODELS.map((model) => [model, WEBGLLM_MODEL_META[model].reasoning ?? false])
) as Readonly<Record<WebGllmChatModel, ModelReasoning>>

/** A model's catalog entry. */
export const modelMeta = (model: WebGllmChatModel): WebGllmModelMeta => WEBGLLM_MODEL_META[model]
