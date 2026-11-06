import assert from "node:assert/strict"
import { test } from "node:test"
import { createSampler } from "./sampling.js"

const VOCAB = 150_000
/** Rising scores: the worst case for keeping the k largest, each token beating the last. */
const rising = () => Float32Array.from({ length: VOCAB }, (_, i) => i / VOCAB)
const pick = (data: Float32Array) => data.findIndex((x) => x === 0)

test("topK 0 picks greedily from the whole vocabulary in one pass", () => {
  const sample = createSampler({ temperature: 0, top_k: 0, top_p: 1, repetition_penalty: 1 })
  const data = rising()
  const start = performance.now()
  sample([[0n]], { data })
  const ms = performance.now() - start
  assert.equal(pick(data), VOCAB - 1)
  assert.ok(ms < 200, `one token took ${ms.toFixed(0)} ms`)
})

test("topK 0 samples from every token, and fast", () => {
  const draws = new Set<number>()
  const sample = createSampler({ temperature: 1, top_k: 0, top_p: 1, repetition_penalty: 1, seed: 7 })
  const start = performance.now()
  for (let i = 0; i < 20; i++) {
    // Flat scores: any token can come up.
    const data = new Float32Array(VOCAB)
    sample([[0n]], { data })
    draws.add(pick(data))
  }
  const ms = (performance.now() - start) / 20
  assert.ok(draws.size > 15, "draws spread over the vocabulary")
  assert.ok(ms < 200, `one token took ${ms.toFixed(0)} ms`)
})

test("topK 0 with topP keeps the likeliest share", () => {
  const sample = createSampler({ temperature: 1, top_k: 0, top_p: 0.5, repetition_penalty: 1, seed: 3 })
  for (let i = 0; i < 20; i++) {
    const data = new Float32Array(1000).fill(-20)
    data[10] = 5
    data[20] = 4.9
    sample([[0n]], { data })
    assert.ok([10, 20].includes(pick(data)))
  }
})
