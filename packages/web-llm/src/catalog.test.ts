/**
 * The catalog is WebLLM's own: its chat models, without its embedding models.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModelType, prebuiltAppConfig } from "@mlc-ai/web-llm"

import { WEB_LLM_CHAT_MODELS, WEB_LLM_MODEL_META } from "./model-meta.js"

test("the catalog is WebLLM's chat models, each with its own entry", () => {
  const chat = prebuiltAppConfig.model_list.filter((record) => record.model_type !== ModelType.embedding)
  assert.deepEqual(WEB_LLM_CHAT_MODELS, chat.map((record) => record.model_id))
  assert.ok(WEB_LLM_CHAT_MODELS.length > 0)
  for (const record of chat) assert.equal(WEB_LLM_MODEL_META[record.model_id], record)
  const embedding = prebuiltAppConfig.model_list.filter((record) => record.model_type === ModelType.embedding)
  for (const record of embedding) assert.ok(!WEB_LLM_CHAT_MODELS.includes(record.model_id))
})
