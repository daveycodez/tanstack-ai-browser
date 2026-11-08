import assert from "node:assert/strict"
import { test } from "node:test"

import { isSupported, loadModel, modelStatus } from "./runtime.js"

test("without the Prompt API, a load left unawaited raises no unhandled rejection; awaited, it rejects", async () => {
  assert.equal("LanguageModel" in globalThis, false)
  assert.equal(await isSupported(), false)
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void loadModel("built-in")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    assert.equal(modelStatus("built-in").get().state, "error")
    await assert.rejects(loadModel("built-in"), /no built-in language model/)
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})
