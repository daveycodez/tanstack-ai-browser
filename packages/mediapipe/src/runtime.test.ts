import assert from "node:assert/strict"
import { test } from "node:test"

import { isSupported, loadModel, modelStatus, unloadModel } from "./runtime.js"

const MODEL = "universal-sentence-encoder"

test("isSupported is false on a server, which has no Web Worker", () => {
  assert.equal(typeof Worker, "undefined")
  assert.equal(isSupported(), false)
  assert.equal(isSupported(MODEL), false)
})

test("a failed load left unawaited raises no unhandled rejection; awaited, it rejects; its status says why", async () => {
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void loadModel(MODEL)
    void loadModel("not-a-model" as typeof MODEL)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    const status = modelStatus(MODEL).get()
    assert.equal(status.state, "error")
    assert.match(status.state === "error" ? status.message : "", /Web Workers/)
    await assert.rejects(loadModel(MODEL), /Web Workers/)
    await assert.rejects(
      loadModel("not-a-model" as typeof MODEL),
      /Unknown MediaPipe embedding model/
    )
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("unloading with nothing loaded does nothing", async () => {
  await unloadModel()
  await unloadModel(MODEL)
})
