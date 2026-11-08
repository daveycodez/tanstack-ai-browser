import assert from "node:assert/strict"
import { test } from "node:test"

import { promptApiText } from "./adapter.js"
import type { Availability, LanguageModelCoreOptions } from "./types.js"

test("without the Prompt API, the model is unavailable; a load left unawaited raises no unhandled rejection; awaited, it rejects", async () => {
  assert.equal("LanguageModel" in globalThis, false)
  const adapter = promptApiText("built-in")
  assert.equal(await adapter.availability(), "unavailable")
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void adapter.createSessionWithProgress()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    await assert.rejects(adapter.createSessionWithProgress(), /no built-in language model/)
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("availability is the browser's own answer for the adapter's languages and inputs; the download reports progress, then 1", async () => {
  const asked: Array<LanguageModelCoreOptions | undefined> = []
  let answer: Availability = "downloadable"
  let destroyed = 0
  const scope = globalThis as { LanguageModel?: unknown }
  scope.LanguageModel = {
    availability: async (options?: LanguageModelCoreOptions) => {
      asked.push(options)
      return answer
    },
    create: async (options: { monitor?: (monitor: EventTarget) => void }) => {
      const monitor = new EventTarget()
      options.monitor?.(monitor)
      for (const loaded of [0, 0.5, 1]) {
        monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }))
      }
      answer = "available"
      return { contextWindow: 9216, destroy: () => destroyed++ }
    }
  }
  try {
    const adapter = promptApiText("built-in", { languages: ["fr"], inputs: ["image"] })
    assert.equal(await adapter.availability(), "downloadable")
    assert.deepEqual(asked[0]?.expectedInputs, [{ type: "text", languages: ["fr"] }, { type: "image" }])
    assert.deepEqual(asked[0]?.expectedOutputs, [{ type: "text", languages: ["fr"] }])
    answer = "downloading"
    assert.equal(await adapter.availability(), "downloading")
    const progress: Array<number> = []
    assert.equal(await adapter.createSessionWithProgress((value) => progress.push(value)), adapter)
    assert.deepEqual(progress, [0.5, 1], "the browser's download, then 1 once the model started")
    assert.equal(destroyed, 1, "the session made to start the model is freed")
    assert.equal(await adapter.availability(), "available")
    const late: Array<number> = []
    await promptApiText("built-in").createSessionWithProgress((value) => late.push(value))
    assert.deepEqual(late, [1], "a model already started reports 1 at once")
    await adapter.destroySession()
    assert.equal(await adapter.availability(), "available", "the browser keeps its model")
    // The browser removes its model (to free space, say): a load asks again and starts it again.
    answer = "downloadable"
    const again: Array<number> = []
    await promptApiText("built-in").createSessionWithProgress((value) => again.push(value))
    assert.deepEqual(again, [0.5, 1], "downloaded again, not a stale 1")
    assert.equal(destroyed, 2, "create() was called again")
    assert.equal(await adapter.availability(), "available")
  } finally {
    delete scope.LanguageModel
  }
})
