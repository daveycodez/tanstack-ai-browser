/**
 * The models WebLLM runs, from its own catalog (`prebuiltAppConfig`): its
 * chat models, leaving out its embedding models.
 */
import { ModelType, prebuiltAppConfig } from "@mlc-ai/web-llm"
import type { ModelRecord } from "@mlc-ai/web-llm"
import type { ModelReasoning } from "@tanstack/ai"

import { THINKING_MODELS } from "./thinking-models.js"

/** A model's catalog entry, as WebLLM gives it. */
export type WebLlmModelMeta = ModelRecord

const chatRecords = prebuiltAppConfig.model_list.filter((record) => record.model_type !== ModelType.embedding)

/**
 * A model WebLLM's catalog lists (its `model_id`). WebLLM types its catalog
 * as a list, not by name, so this is a string.
 */
export type WebLlmChatModel = ModelRecord["model_id"]

/** The models WebLLM runs: its catalog's chat models, by `model_id`. */
export const WEB_LLM_CHAT_MODELS: ReadonlyArray<WebLlmChatModel> = chatRecords.map((record) => record.model_id)

/** Each chat model's catalog entry, by `model_id`. */
export const WEB_LLM_MODEL_META: Readonly<Record<WebLlmChatModel, WebLlmModelMeta>> = Object.fromEntries(
  chatRecords.map((record) => [record.model_id, record])
)

/**
 * Thinking on and off, for a model whose chat template has the switch:
 * WebLLM's `enable_thinking` (off starts the reply with an empty
 * `<think></think>`). WebLLM has no thinking budget.
 */
export const THINKING_SWITCH = { levels: { off: "false", high: "true" }, budget: false } as const

/**
 * Each chat model's reasoning levels (`false`: no switch), for
 * `chat({ reasoning })` and `supportedReasoningLevels()`. WebLLM's catalog
 * doesn't say which models think: the switch is for the models whose chat
 * template has `enable_thinking` (thinking-models.ts, read from each
 * model's files). Thinking a model does without it still shows.
 */
export const WEB_LLM_MODEL_REASONING: Readonly<Record<WebLlmChatModel, ModelReasoning>> = Object.fromEntries(
  chatRecords.map((record) => [record.model_id, THINKING_MODELS.includes(record.model_id) ? THINKING_SWITCH : false])
)
