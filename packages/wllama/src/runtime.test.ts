import assert from "node:assert/strict"
import { test } from "node:test"

import { isSupported } from "./runtime.js"

test("isSupported is false on a server, which has no Web Worker or Origin Private File System", () => {
  assert.equal(typeof Worker, "undefined")
  assert.equal(isSupported(), false)
  assert.equal(isSupported("LiquidAI/LFM2.5-350M-GGUF"), false)
})
