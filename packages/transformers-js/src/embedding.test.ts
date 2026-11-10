import assert from "node:assert/strict"
import { test } from "node:test"

import { embed } from "@tanstack/ai"

import { transformersJsEmbedding } from "./embedding.js"
import type { TransformersJsEmbeddingConfig } from "./embedding.js"

type Shaped = { dims: Array<number>; tolist(): unknown; normalize(): Shaped; slice(): Shaped; normalized?: boolean }

/** A stand-in tensor: a vector a token for each text, or one pooled vector a text. */
const tensor = (texts: number, pooled: boolean, normalized = false): Shaped => {
  const token = [0.1, 0.2, 0.3, 0.4]
  return {
    dims: pooled ? [texts, 4] : [texts, 3, 4],
    normalized,
    tolist: () => Array.from({ length: texts }, () => (pooled ? token : [token, token, token])),
    normalize: () => tensor(texts, pooled, true),
    slice: () => tensor(texts, true, normalized)
  }
}

/** A loaded feature-extraction pipeline's parts: three tokens a text, the last of the second padding. */
function fakeLoaded() {
  const tokenized: Array<Record<string, unknown>> = []
  const steps: Array<string> = []
  const loaded = {
    extractor: {
      tokenizer: (texts: Array<string>, options: Record<string, unknown>) => {
        tokenized.push(options)
        return { attention_mask: { data: BigInt64Array.from(texts.flatMap((_, i) => (i === 1 ? [1n, 1n, 0n] : [1n, 1n, 1n]))) } }
      },
      model: async () => ({ last_hidden_state: tensor(2, false) }),
      dispose: async () => undefined
    },
    mean_pooling: (hidden: Shaped) => {
      steps.push("mean")
      return tensor(hidden.dims[0], true)
    },
    quantize_embeddings: (output: Shaped) => {
      steps.push("quantize")
      return output
    }
  }
  return { loaded, tokenized, steps }
}

/** The adapter with the fake pipeline in place of Transformers.js's. */
function adapterWith(loaded: unknown, config: TransformersJsEmbeddingConfig = {}) {
  const adapter = transformersJsEmbedding(undefined, config)
  Object.assign(adapter, { extractor: Promise.resolve(loaded) })
  return adapter
}

test("embeddings: one pooled vector a text, mean-pooled and normalized by default, with the tokens read", async () => {
  const { loaded, tokenized, steps } = fakeLoaded()
  const { embeddings, usage } = await embed({ adapter: adapterWith(loaded), input: ["a", "b"] })
  assert.deepEqual(embeddings.map((e) => e.vector), [[0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4]])
  assert.deepEqual(steps, ["mean"])
  assert.deepEqual(tokenized[0], { padding: true, truncation: true }, "the model's own limit")
  assert.deepEqual(usage, { promptTokens: 5, completionTokens: 0, totalTokens: 5 }, "padding isn't counted")
})

test("embeddings: maxTokens cuts each text at the tokenizer; quantize runs Transformers.js's own", async () => {
  const { loaded, tokenized, steps } = fakeLoaded()
  await embed({ adapter: adapterWith(loaded, { maxTokens: 128 }), input: ["a", "b"], modelOptions: { pooling: "cls", quantize: true } })
  assert.deepEqual(tokenized[0], { padding: true, truncation: true, max_length: 128 })
  assert.deepEqual(steps, ["quantize"])
})

test("embeddings: unpooled output (a vector a token) is refused, not returned as vectors", async () => {
  const { loaded } = fakeLoaded()
  await assert.rejects(
    embed({ adapter: adapterWith(loaded), input: ["a", "b"], modelOptions: { pooling: "none" } as never }),
    /pool/
  )
})
