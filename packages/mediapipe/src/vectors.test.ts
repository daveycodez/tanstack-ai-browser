import assert from "node:assert/strict"
import { test } from "node:test"

import { toVector } from "./vectors.js"

test("a float embedding is its numbers", () => {
  assert.deepEqual(Array.from(toVector({ floatEmbedding: [0.5, -0.25, 0] })), [0.5, -0.25, 0])
})

test("a quantized embedding's bytes read as signed integers", () => {
  const vector = toVector({
    floatEmbedding: [],
    quantizedEmbedding: new Uint8Array([0, 127, 128, 255])
  })
  assert.deepEqual(Array.from(vector), [0, 127, -128, -1])
})

test("no embedding throws", () => {
  assert.throws(() => toVector(undefined), /no embedding/)
})
