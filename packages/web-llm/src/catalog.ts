/**
 * The models WebLLM runs, from its own catalog (`prebuiltAppConfig`): its
 * chat models, leaving out its embedding models.
 */
import { ModelType, prebuiltAppConfig } from "@mlc-ai/web-llm"
import type { ModelRecord } from "@mlc-ai/web-llm"

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
