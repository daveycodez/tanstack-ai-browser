/** Where the engine can't run (Node has no WebGL 2), every model is "unavailable". */
import assert from "node:assert/strict"
import { test } from "node:test"

import { webgllmText } from "./adapter.js"
import { MODEL } from "./fake-webgllm.test.js"

test("availability is unavailable where the engine can't run", async () => {
  assert.equal(await webgllmText(MODEL).availability(), "unavailable")
})
