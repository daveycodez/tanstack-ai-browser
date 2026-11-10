import assert from "node:assert/strict"
import { test } from "node:test"

import { embed } from "@tanstack/ai"

import { transformersJsEmbedding } from "./embedding.js"

/** A feature-extraction pipeline's output for two texts of three tokens, 4 numbers a token. */
function fakeExtractor() {
  const calls: Array<Record<string, unknown>> = []
  const extractor = async (texts: Array<string>, options: Record<string, unknown>) => {
    calls.push(options)
    const tokens = Array.from({ length: 3 }, () => [0.1, 0.2, 0.3, 0.4])
    const list = options.pooling === "none" ? texts.map(() => tokens) : texts.map(() => tokens[0])
    return { dims: options.pooling === "none" ? [texts.length, 3, 4] : [texts.length, 4], tolist: () => list }
  }
  return { extractor, calls }
}

/** The adapter with the fake pipeline in place of Transformers.js's. */
function adapterWith(extractor: unknown) {
  const adapter = transformersJsEmbedding()
  Object.assign(adapter, { extractor: Promise.resolve(extractor) })
  return adapter
}

test("embeddings: one pooled vector a text, mean-pooled and normalized by default", async () => {
  const { extractor, calls } = fakeExtractor()
  const { embeddings } = await embed({ adapter: adapterWith(extractor), input: ["a", "b"] })
  assert.deepEqual(embeddings.map((e) => e.vector), [[0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4]])
  assert.deepEqual(calls[0], { pooling: "mean", normalize: true })
})

test("embeddings: unpooled output (a vector a token) is refused, not returned as vectors", async () => {
  const { extractor } = fakeExtractor()
  await assert.rejects(
    embed({ adapter: adapterWith(extractor), input: ["a", "b"], modelOptions: { pooling: "none" } as never }),
    /pool/
  )
})
