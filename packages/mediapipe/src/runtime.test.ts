import assert from "node:assert/strict"
import { test } from "node:test"

import { mediaPipeEmbedding } from "./adapter.js"

const MODEL = "universal-sentence-encoder"

test("on a server, which has no Web Worker, the model is unavailable", async () => {
  assert.equal(typeof Worker, "undefined")
  assert.equal(await mediaPipeEmbedding(MODEL).availability(), "unavailable")
})

test("a failed load left unawaited raises no unhandled rejection; awaited, it rejects", async () => {
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void mediaPipeEmbedding(MODEL).create()
    void mediaPipeEmbedding("not-a-model" as typeof MODEL).create()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    await assert.rejects(mediaPipeEmbedding(MODEL).create(), /Web Workers/)
    await assert.rejects(
      mediaPipeEmbedding("not-a-model" as typeof MODEL).create(),
      /Unknown MediaPipe embedding model/
    )
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("destroying the session with nothing loaded does nothing", async () => {
  await mediaPipeEmbedding(MODEL).destroy()
})
