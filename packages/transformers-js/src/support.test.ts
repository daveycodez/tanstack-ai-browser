import assert from "node:assert/strict"
import { test } from "node:test"

import { modelMeta, modelReasoning, runsWithoutWebGpu } from "./catalog.js"
import { isSupported } from "./client.js"

test("isSupported is false on a server, which has no Web Worker", async () => {
  assert.equal(typeof Worker, "undefined")
  assert.equal(await isSupported(), false)
  assert.equal(await isSupported("onnx-community/LFM2-1.2B-Tool-ONNX"), false)
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
