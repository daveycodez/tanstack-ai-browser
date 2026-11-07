import assert from "node:assert/strict"
import { test } from "node:test"

import { isSupported, loadModel, modelStatus } from "./runtime.js"

const MODEL = "LiquidAI/LFM2.5-350M-GGUF"

test("isSupported is false on a server, which has no Web Worker or Origin Private File System", () => {
  assert.equal(typeof Worker, "undefined")
  assert.equal(isSupported(), false)
  assert.equal(isSupported(MODEL), false)
})

test("a failed load left unawaited raises no unhandled rejection; awaited, it rejects; its status says why", async () => {
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    // wllama can't start on a server (no storage it can use).
    void loadModel(MODEL)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    assert.equal(modelStatus(MODEL).get().state, "error")
    await assert.rejects(loadModel(MODEL))
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})
