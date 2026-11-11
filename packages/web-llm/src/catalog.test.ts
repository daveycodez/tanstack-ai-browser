/**
 * The catalog is WebLLM's own: its chat models, without its embedding models.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModelType, prebuiltAppConfig } from "@mlc-ai/web-llm"

import { WEB_LLM_CHAT_MODELS, WEB_LLM_MODEL_REASONING } from "./catalog.js"
import { THINKING_MODELS } from "./thinking-models.js"

test("the chat models are WebLLM's catalog's, without its embedding models", () => {
  const chat = prebuiltAppConfig.model_list.filter((record) => record.model_type !== ModelType.embedding)
  assert.deepEqual(WEB_LLM_CHAT_MODELS, chat.map((record) => record.model_id))
  assert.ok(WEB_LLM_CHAT_MODELS.length > 0)
  const embedding = prebuiltAppConfig.model_list.filter((record) => record.model_type === ModelType.embedding)
  for (const record of embedding) assert.ok(!WEB_LLM_CHAT_MODELS.includes(record.model_id))
})

test("reasoning levels: off and high for models whose chat template has the switch, none for the rest", () => {
  assert.deepEqual(WEB_LLM_MODEL_REASONING["Qwen3-0.6B-q4f16_1-MLC"], { levels: { off: "false", high: "true" }, budget: false })
  assert.equal(WEB_LLM_MODEL_REASONING["Qwen2.5-0.5B-Instruct-q4f16_1-MLC"], false)
  assert.equal(WEB_LLM_MODEL_REASONING["DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC"], false)
  for (const model of THINKING_MODELS) assert.ok(WEB_LLM_CHAT_MODELS.includes(model), `${model} is in the catalog`)
})
