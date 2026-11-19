import assert from "node:assert/strict"
import { test } from "node:test"

import { FIRST_PASS, LOGITS_PASS, MIN_PASS, passSize, readInPasses } from "./prompt-passes.js"

/**
 * Passes over a cache that is its length here, on a clock where a pass of n
 * tokens takes n × `msPerToken` (a function of the pass's index, to change
 * speed between passes); `leaves` is what a pass to `end` leaves in the cache.
 */
function passes(options: { msPerToken?: (pass: number) => number; known?: number; cap?: number; leaves?: (end: number) => number; stopAfter?: number } = {}) {
  const { msPerToken = () => 1, known, cap = Number.POSITIVE_INFINITY, leaves = (end: number) => end, stopAfter = Number.POSITIVE_INFINITY } = options
  const ends: Array<number> = []
  const disposed: Array<number> = []
  const measured: Array<number> = []
  let clock = 0
  let read = 0
  return {
    ends,
    disposed,
    measured,
    passes: {
      lengthOf: (cache: number) => cache,
      read: async (end: number, cache: number | undefined) => {
        clock += (end - (cache ?? read)) * msPerToken(ends.length)
        read = end
        ends.push(end)
        return leaves(end)
      },
      dispose: async (cache: number) => void disposed.push(cache),
      stopped: () => ends.length >= stopAfter,
      cap,
      msPerToken: known,
      measured: (ms: number) => void measured.push(ms),
      now: () => clock
    }
  }
}

test("a pass is sized to take about a second at the speed so far: FIRST_PASS while it's unknown, MIN_PASS at least, the cap at most", () => {
  assert.equal(passSize(undefined, Number.POSITIVE_INFINITY), FIRST_PASS)
  assert.equal(passSize(0.25, Number.POSITIVE_INFINITY), 4000)
  assert.equal(passSize(0.25, LOGITS_PASS), LOGITS_PASS)
  assert.equal(passSize(8, Number.POSITIVE_INFINITY), 125)
  assert.equal(passSize(100, Number.POSITIVE_INFINITY), MIN_PASS)
})

test("a fast GPU reads a long prompt in one first pass, then the rest in generate()", async () => {
  const run = passes({ msPerToken: () => 0.25 })
  assert.equal(await readInPasses(2060, undefined, run.passes), FIRST_PASS)
  assert.deepEqual(run.ends, [FIRST_PASS])
  assert.deepEqual(run.measured, [0.25])
})

test("a slow GPU reads it in passes of about a second, smaller as it slows down", async () => {
  const run = passes({ msPerToken: (pass) => (pass < 2 ? 8 : 16) })
  const cache = await readInPasses(600, undefined, run.passes)
  // 128 at first, then 125 a pass at 8 ms a token, then 62 at 16 ms.
  assert.deepEqual(run.ends, [128, 253, 378, 440, 502, 564])
  assert.equal(cache, 564)
})

test("a model without num_logits_to_keep reads LOGITS_PASS tokens a pass at most, however fast", async () => {
  const run = passes({ msPerToken: () => 0.1, cap: LOGITS_PASS, known: 0.1 })
  assert.equal(await readInPasses(2060, undefined, run.passes), 2048)
  assert.deepEqual(run.ends, [512, 1024, 1536, 2048])
})

test("passes start from what a reused cache holds; a prompt that fits in one pass isn't split", async () => {
  const run = passes({ known: 2 })
  assert.equal(await readInPasses(1100, 700, run.passes), 700)
  assert.deepEqual(run.ends, [])
  const longer = passes({ known: 2, msPerToken: () => 2 })
  assert.equal(await readInPasses(1800, 700, longer.passes), 1700)
  assert.deepEqual(longer.ends, [1200, 1700])
})

test("a pass that doesn't leave exactly its tokens in the cache gives up: no cache, so generate() reads the whole prompt", async () => {
  const run = passes({ leaves: (end) => end + 1 })
  assert.equal(await readInPasses(2060, undefined, run.passes), undefined)
  assert.deepEqual(run.ends, [FIRST_PASS])
  assert.deepEqual(run.disposed, [FIRST_PASS + 1])
})

test("a cache whose length can't be told is left to generate(); a stopped reply makes no more passes", async () => {
  const unknown = { ...passes().passes, lengthOf: () => undefined }
  assert.equal(await readInPasses(5000, 7, unknown), 7)
  const run = passes({ known: 10, stopAfter: 1 })
  assert.equal(await readInPasses(2060, undefined, run.passes), 100)
  assert.deepEqual(run.ends, [100])
})
