import assert from "node:assert/strict"
import { test } from "node:test"

import { readInPasses } from "./prompt-passes.js"

/** A cache is its length here; `leaves` is what a pass to `end` leaves in it. */
function passes(leaves: (end: number) => number = (end) => end, stopAfter = Infinity) {
  const ends: Array<number> = []
  const disposed: Array<number> = []
  return {
    ends,
    disposed,
    passes: {
      lengthOf: (cache: number) => cache,
      read: async (end: number) => {
        ends.push(end)
        return leaves(end)
      },
      dispose: async (cache: number) => void disposed.push(cache),
      stopped: () => ends.length >= stopAfter
    }
  }
}

test("a long prompt is read 512 tokens a pass, leaving the last 512 or fewer to generate()", async () => {
  const run = passes()
  assert.equal(await readInPasses(2060, undefined, run.passes), 2048)
  assert.deepEqual(run.ends, [512, 1024, 1536, 2048])
})

test("passes start from what a reused cache holds; 512 tokens or fewer past it are left as they are", async () => {
  const run = passes()
  assert.equal(await readInPasses(1300, 700, run.passes), 1212)
  assert.deepEqual(run.ends, [1212])
  const short = passes()
  assert.equal(await readInPasses(600, 100, short.passes), 100)
  assert.deepEqual(short.ends, [])
})

test("a pass that doesn't leave exactly its tokens in the cache gives up: no cache, so generate() reads the whole prompt", async () => {
  const run = passes((end) => end + 1)
  assert.equal(await readInPasses(2060, undefined, run.passes), undefined)
  assert.deepEqual(run.ends, [512])
  assert.deepEqual(run.disposed, [513])
})

test("a cache whose length can't be told is left to generate(); a stopped reply makes no more passes", async () => {
  const unknown = { ...passes().passes, lengthOf: () => undefined }
  assert.equal(await readInPasses(5000, 7, unknown), 7)
  const run = passes(undefined, 1)
  assert.equal(await readInPasses(2060, undefined, run.passes), 512)
  assert.deepEqual(run.ends, [512])
})
