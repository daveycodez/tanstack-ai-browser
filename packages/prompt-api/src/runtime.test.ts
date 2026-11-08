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
    void adapter.create()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    await assert.rejects(adapter.create(), /no built-in language model/)
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
    assert.equal(await adapter.create({ onDownloadProgress: (value) => progress.push(value) }), adapter)
    assert.deepEqual(progress, [0.5, 1], "the browser's download, then 1 once the model started")
    assert.equal(destroyed, 1, "the session made to start the model is freed")
    assert.equal(await adapter.availability(), "available")
    const late: Array<number> = []
    await promptApiText("built-in").create({ onDownloadProgress: (value) => late.push(value) })
    assert.deepEqual(late, [1], "a model already started reports 1 at once")
    await adapter.destroySession()
    assert.equal(await adapter.availability(), "available", "the browser keeps its model")
    // The browser removes its model (to free space, say): a load asks again and starts it again.
    answer = "downloadable"
    const again: Array<number> = []
    await promptApiText("built-in").create({ onDownloadProgress: (value) => again.push(value) })
    assert.deepEqual(again, [0.5, 1], "downloaded again, not a stale 1")
    assert.equal(destroyed, 2, "create() was called again")
    assert.equal(await adapter.availability(), "available")
  } finally {
    delete scope.LanguageModel
  }
})

test("create's signal: aborted before, create() isn't called; the only waiter aborting aborts the native create(); one of two leaving keeps it for the other", async () => {
  const creates: Array<{ signal: AbortSignal; monitor: EventTarget; finish: () => void }> = []
  let answer: Availability = "downloadable"
  const scope = globalThis as { LanguageModel?: unknown }
  scope.LanguageModel = {
    availability: async () => answer,
    create: (options: { signal: AbortSignal; monitor?: (monitor: EventTarget) => void }) =>
      new Promise((resolve, reject) => {
        const monitor = new EventTarget()
        options.monitor?.(monitor)
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
        creates.push({
          signal: options.signal,
          monitor,
          finish: () => {
            answer = "available"
            monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 1 }))
            resolve({ contextWindow: 9216, destroy: () => undefined })
          }
        })
      })
  }
  const progress = (index: number, loaded: number) =>
    creates[index]!.monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }))
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const adapter = promptApiText("built-in")
    await assert.rejects(adapter.create({ signal: AbortSignal.abort() }), (error: unknown) => error instanceof DOMException && error.name === "AbortError")
    assert.equal(creates.length, 0, "create() isn't called")

    // The only waiter aborts mid-download: the browser's create() is aborted.
    const heard: Array<number> = []
    const controller = new AbortController()
    const alone = adapter.create({ onDownloadProgress: (value) => heard.push(value), signal: controller.signal })
    await tick()
    progress(0, 0.3)
    controller.abort()
    await assert.rejects(alone, { name: "AbortError" })
    assert.equal(creates[0]!.signal.aborted, true, "the native create() was aborted")
    progress(0, 0.6)
    assert.deepEqual(heard, [0.3], "nothing more after the abort")
    assert.equal(await adapter.availability(), "downloadable")

    // Two waiters: one leaves, the other still hears progress and completion.
    const leaving: Array<number> = []
    const staying: Array<number> = []
    const leave = new AbortController()
    const first = adapter.create({ onDownloadProgress: (value) => leaving.push(value), signal: leave.signal })
    const second = adapter.create({ onDownloadProgress: (value) => staying.push(value) })
    await tick()
    assert.equal(creates.length, 2, "one native create() for both")
    progress(1, 0.2)
    leave.abort()
    await assert.rejects(first, { name: "AbortError" })
    assert.equal(creates[1]!.signal.aborted, false, "the other caller still waits")
    progress(1, 0.7)
    creates[1]!.finish()
    assert.equal(await second, adapter)
    assert.deepEqual(leaving, [0.2])
    assert.deepEqual(staying, [0.2, 0.7, 1])
    assert.equal(await adapter.availability(), "available")

    const ignored = new AbortController()
    answer = "downloadable"
    void promptApiText("built-in").create({ signal: ignored.signal })
    await tick()
    ignored.abort()
    await tick()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    delete scope.LanguageModel
  }
})

test("after the last caller aborts, a new create() starts afresh even while the browser is still settling the canceled create(); a warm create() stops waiting on the availability probe when aborted", async () => {
  const creates: Array<{ signal: AbortSignal; finish: () => void }> = []
  let answer: Availability = "downloadable"
  let probe: Promise<void> | null = null
  const scope = globalThis as { LanguageModel?: unknown }
  scope.LanguageModel = {
    availability: async () => {
      if (probe) await probe
      return answer
    },
    // A browser that takes its time to settle an aborted create(): it ignores the signal.
    create: (options: { signal: AbortSignal; monitor?: (monitor: EventTarget) => void }) =>
      new Promise((resolve) => {
        options.monitor?.(new EventTarget())
        creates.push({
          signal: options.signal,
          finish: () => {
            answer = "available"
            resolve({ contextWindow: 9216, destroy: () => undefined })
          }
        })
      })
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const adapter = promptApiText("built-in")
    const controller = new AbortController()
    const canceled = adapter.create({ signal: controller.signal })
    await tick()
    controller.abort()
    await assert.rejects(canceled, { name: "AbortError" })
    assert.equal(creates[0]!.signal.aborted, true)
    const retry = adapter.create()
    await tick()
    assert.equal(creates.length, 2, "a fresh native create(), not the canceled one")
    creates[1]!.finish()
    assert.equal(await retry, adapter)
    creates[0]!.finish()

    // Warm: the model started; the availability probe is slow.
    let answerProbe!: () => void
    probe = new Promise<void>((resolve) => { answerProbe = resolve })
    const warm = new AbortController()
    const waiting = adapter.create({ signal: warm.signal })
    await tick()
    warm.abort()
    await assert.rejects(waiting, { name: "AbortError" })
    answerProbe()
  } finally {
    delete scope.LanguageModel
  }
})
