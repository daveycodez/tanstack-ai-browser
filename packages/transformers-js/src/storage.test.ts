import assert from "node:assert/strict"
import { test } from "node:test"

import { startLoad } from "./storage.js"

test("a load that ends well reports 1, even with nothing downloaded; a failed one doesn't", () => {
  const seen: Array<number> = []
  startLoad((value) => seen.push(value)).end(true)
  assert.deepEqual(seen, [1])
  const failed: Array<number> = []
  startLoad((value) => failed.push(value)).end(false)
  assert.deepEqual(failed, [])
})

test("ending a load twice counts once", () => {
  const seen: Array<number> = []
  const load = startLoad((value) => seen.push(value))
  load.end(true)
  load.end(true)
  assert.deepEqual(seen, [1])
})
