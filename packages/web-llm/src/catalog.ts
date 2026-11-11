/**
 * The models WebLLM runs, by name, from its own catalog (`prebuiltAppConfig`,
 * which the package re-exports as it is): its chat models (some of which
 * read images) and its embedding models, with what the catalog doesn't
 * say, which chat models have the thinking switch.
 */
import { ModelType, prebuiltAppConfig } from "@mlc-ai/web-llm"
import type { ModelRecord } from "@mlc-ai/web-llm"
import type { ModelReasoning } from "@tanstack/ai"

import { THINKING_MODELS } from "./thinking-models.js"

const chatRecords = prebuiltAppConfig.model_list.filter((record) => record.model_type !== ModelType.embedding)

/**
 * A model WebLLM's catalog lists (its `model_id`). WebLLM types its catalog
 * as a list, not by name, so this is a string.
 */
export type WebLlmChatModel = ModelRecord["model_id"]

/** The models WebLLM runs: its catalog's chat models, by `model_id`. */
export const WEB_LLM_CHAT_MODELS: ReadonlyArray<WebLlmChatModel> = chatRecords.map((record) => record.model_id)

/**
 * The input each chat model reads: text, and images for WebLLM's vision
 * models (its catalog's `model_type` VLM).
 */
export const WEB_LLM_MODEL_INPUT: Readonly<Record<WebLlmChatModel, ReadonlyArray<"text" | "image">>> = Object.fromEntries(
  chatRecords.map((record) => [record.model_id, record.model_type === ModelType.VLM ? ["text", "image"] : ["text"]])
)

const embeddingRecords = prebuiltAppConfig.model_list.filter((record) => record.model_type === ModelType.embedding)

/** An embedding model WebLLM's catalog lists (its `model_id`). */
export type WebLlmEmbeddingModel = ModelRecord["model_id"]

/** WebLLM's embedding models (Snowflake's Arctic Embed), by `model_id`. */
export const WEB_LLM_EMBEDDING_MODELS: ReadonlyArray<WebLlmEmbeddingModel> = embeddingRecords.map((record) => record.model_id)

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
