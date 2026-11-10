/** Where the engine can't run (Node has no WebGL 2), every model is "unavailable". */
import assert from "node:assert/strict"
import { test } from "node:test"

import { webgllmText } from "./adapter.js"
import { MODEL } from "./fake-webgllm.test.js"

test("availability is unavailable where the engine can't run", async () => {
  assert.equal(await webgllmText(MODEL).availability(), "unavailable")
})

test("with workers of your own the page isn't checked: availability reads storage, in an engine of their own", async () => {
  const worker = () => {
    throw new Error("no worker in this test")
  }
  assert.equal(await webgllmText(MODEL, { worker }).availability(), "downloadable")
})
