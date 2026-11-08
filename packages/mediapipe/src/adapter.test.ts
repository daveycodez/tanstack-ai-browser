import assert from "node:assert/strict"
import { test } from "node:test"
import { embed } from "@tanstack/ai"

import { MediaPipeEmbeddingAdapter, mediaPipeEmbedding } from "./index.js"
import { MEDIAPIPE_EMBEDDING_MODELS, MEDIAPIPE_MODEL_META } from "./model-meta.js"

test("the factory defaults to Universal Sentence Encoder, as an embedding adapter named mediapipe", () => {
  const adapter = mediaPipeEmbedding()
  assert.ok(adapter instanceof MediaPipeEmbeddingAdapter)
  assert.equal(adapter.kind, "embedding")
  assert.equal(adapter.name, "mediapipe")
  assert.equal(adapter.model, "universal-sentence-encoder")
  assert.deepEqual(MEDIAPIPE_EMBEDDING_MODELS, ["universal-sentence-encoder"])
  assert.equal(MEDIAPIPE_MODEL_META["universal-sentence-encoder"].dimensions, 100)
})

test("dimensions other than the model's 100 throw a clear error before anything loads", async () => {
  await assert.rejects(
    embed({ adapter: mediaPipeEmbedding(), input: "a red guitar", dimensions: 256, debug: false }),
    /returns 100 dimensions and can't return 256/
  )
})

test("image inputs throw: the model is text-only", async () => {
  const image = { type: "image", source: { type: "url", value: "https://example.com/a.png" } }
  await assert.rejects(
    embed({
      adapter: mediaPipeEmbedding(),
      // An untyped caller: the model's input modalities reject this at compile time.
      input: [image] as unknown as Array<string>,
      debug: false
    }),
    /only supports text embedding inputs/
  )
})

test("dimensions: 100 and text parts get as far as loading, which needs a browser", async () => {
  await assert.rejects(
    embed({
      adapter: mediaPipeEmbedding("universal-sentence-encoder", { delegate: "CPU" }),
      input: ["one", { type: "text", content: "two" }],
      dimensions: 100,
      modelOptions: { l2Normalize: true },
      debug: false
    }),
    /Web Workers/
  )
})

test("no inputs give no vectors, without loading the model", async () => {
  const result = await embed({ adapter: mediaPipeEmbedding(), input: [], debug: false })
  assert.deepEqual(result.embeddings, [])
  assert.equal(result.model, "universal-sentence-encoder")
})
