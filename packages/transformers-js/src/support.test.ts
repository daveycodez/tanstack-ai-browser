import assert from "node:assert/strict"
import { test } from "node:test"

import { modelMeta, modelReasoning, runsWithoutWebGpu } from "./catalog.js"
import { transformersJsText } from "./adapter.js"

test("on a server, which has no Web Worker, models are unavailable, and a failed load left unawaited raises no unhandled rejection", async () => {
  assert.equal(typeof Worker, "undefined")
  const adapter = transformersJsText("onnx-community/LFM2-1.2B-Tool-ONNX")
  assert.equal(await adapter.availability(), "unavailable")
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void adapter.createSessionWithProgress()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    await assert.rejects(adapter.createSessionWithProgress())
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("a listed model pinned to a revision is looked up as the listed model", () => {
  const pinned = "LiquidAI/LFM2.5-350M-ONNX@0123456789abcdef"
  assert.equal(modelMeta(pinned), modelMeta("LiquidAI/LFM2.5-350M-ONNX"))
  assert.equal(runsWithoutWebGpu(pinned), false, "its q4 graph has no CPU kernel")
  assert.equal(modelReasoning(pinned), undefined, "it doesn't reason")
  assert.equal(runsWithoutWebGpu("onnx-community/LFM2-1.2B-Tool-ONNX@main"), true)
  assert.deepEqual(
    modelReasoning("onnx-community/Qwen3.5-2B-ONNX@abc"),
    modelReasoning("onnx-community/Qwen3.5-2B-ONNX")
  )
  // Any other id is unknown here: assumed to run on the CPU, with the on/off toggle.
  assert.equal(modelMeta("owner/other@abc"), undefined)
  assert.equal(runsWithoutWebGpu("owner/other@abc"), true)
  assert.ok(modelReasoning("owner/other@abc"))
})
