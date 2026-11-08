import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { mediaPipeEmbedding } from "./adapter.js"
import { availability, embedTexts, loadModel, loadRequest, unloadModel } from "./client.js"
import type { WorkerRequest, WorkerResponse } from "./protocol.js"
import { MEDIAPIPE_WASM_URL } from "./version.js"

const MODEL = "universal-sentence-encoder"
const OPTIONS = { l2Normalize: false, quantize: false }

/** A stand-in for the embedder's worker: loads after a tick, embeds after another. */
class FakeWorker {
  static created: Array<FakeWorker> = []
  /** Loads only when the test replies "ready" itself. */
  static manual = false
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  load: Extract<WorkerRequest, { type: "load" }> | undefined
  terminated = false
  constructor() {
    FakeWorker.created.push(this)
  }
  postMessage(data: WorkerRequest) {
    if (data.type === "load") {
      this.load = data
      if (!FakeWorker.manual) setTimeout(() => this.reply({ type: "ready" }), 5)
    } else {
      const vectors = data.texts.map(() => new Float32Array([1, 2]))
      setTimeout(() => this.reply({ type: "embedded", id: data.id, vectors }), 20)
    }
  }
  reply(data: WorkerResponse) {
    if (!this.terminated) this.onmessage?.({ data })
  }
  terminate() {
    this.terminated = true
  }
}

const globals = globalThis as { Worker?: unknown }
afterEach(async () => {
  await unloadModel()
  FakeWorker.created = []
  FakeWorker.manual = false
  delete globals.Worker
})

test("calls with the default delegate and an explicit CPU share one worker", async () => {
  globals.Worker = FakeWorker
  const [a, b] = await Promise.all([
    embedTexts(MODEL, { delegate: "CPU" }, ["one"], OPTIONS),
    embedTexts(MODEL, {}, ["two"], OPTIONS)
  ])
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(FakeWorker.created.length, 1)
})

test("a call with other load options waits for the requests in flight before ending their worker", async () => {
  globals.Worker = FakeWorker
  const first = embedTexts(MODEL, { delegate: "CPU" }, ["one"], OPTIONS)
  // Let the first request reach its worker, then switch.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = embedTexts(MODEL, { delegate: "GPU" }, ["two"], OPTIONS)
  const third = embedTexts(MODEL, { delegate: "CPU" }, ["three"], OPTIONS)
  const results = await Promise.all([first, second, third])
  assert.deepEqual(results.map((r) => r.length), [1, 1, 1])
  assert.equal(FakeWorker.created.length >= 2, true)
  // Every worker but the current one is ended once its requests are done.
  assert.deepEqual(
    FakeWorker.created.map((w) => w.terminated),
    FakeWorker.created.map((_, i) => i < FakeWorker.created.length - 1)
  )
})

test("a Worker the browser refuses to create makes loadModel reject", async () => {
  globals.Worker = class {
    constructor() {
      throw new DOMException("Worker blocked", "SecurityError")
    }
  }
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void loadModel(MODEL)
    await assert.rejects(loadModel(MODEL), /Worker blocked/)
    await assert.rejects(embedTexts(MODEL, {}, ["x"], OPTIONS), /Worker blocked/)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  // The next load starts afresh.
  globals.Worker = FakeWorker
  const progress: Array<number> = []
  await loadModel(MODEL, {}, (value) => progress.push(value))
  assert.deepEqual(progress, [1])
})

test("availability: unavailable without a Worker or for an unknown model, downloadable (also while loading, and with its files cached), available once ready", async () => {
  assert.equal(await availability(MODEL), "unavailable")
  globals.Worker = FakeWorker
  assert.equal(await availability("not-a-model" as typeof MODEL), "unavailable")
  assert.equal(await availability(MODEL), "downloadable")
  FakeWorker.manual = true
  const progress: Array<number> = []
  const ready = loadModel(MODEL, {}, (value) => progress.push(value))
  const worker = FakeWorker.created[0]
  worker.reply({ type: "progress", cached: false, loadedBytes: 0, totalBytes: 100 })
  worker.reply({ type: "progress", cached: false, loadedBytes: 50, totalBytes: 100 })
  assert.equal(await availability(MODEL), "downloadable", "a load in progress isn't \"downloading\": progress comes from the callback")
  worker.reply({ type: "ready" })
  await ready
  assert.deepEqual(progress, [0, 0.5, 1])
  assert.equal(await availability(MODEL), "available")
  assert.equal(await availability(MODEL, { cacheWasm: false }), "downloadable", "loaded with other options")
  await unloadModel(MODEL)
  assert.equal(await availability(MODEL), "downloadable", "unloaded: its files stay cached, but it isn't loaded")
})

test("the same progress callback hears 1 on every load call: once for a shared load, then at once on the ready model; embed calls report nothing more", async () => {
  globals.Worker = FakeWorker
  FakeWorker.manual = true
  const heard: Array<number> = []
  const onProgress = (value: number) => heard.push(value)
  const first = loadModel(MODEL, {}, onProgress)
  const second = loadModel(MODEL, {}, onProgress)
  const worker = FakeWorker.created[0]
  worker.reply({ type: "progress", cached: false, loadedBytes: 50, totalBytes: 100 })
  worker.reply({ type: "ready" })
  await Promise.all([first, second])
  assert.deepEqual(heard, [0.5, 1], "one load: its progress and its 1, once")
  await loadModel(MODEL, {}, onProgress)
  await loadModel(MODEL, {}, onProgress)
  assert.deepEqual(heard, [0.5, 1, 1, 1], "each call on the ready model hears 1")
  FakeWorker.manual = false
  await embedTexts(MODEL, {}, ["a"], OPTIONS, onProgress)
  assert.deepEqual(heard, [0.5, 1, 1, 1])
  assert.equal(FakeWorker.created.length, 1)
})

test("a load's signal: aborted before, no worker starts; the only waiter aborting ends the worker; one of two leaving keeps the load for the other; an embed call waiting keeps it too", async () => {
  globals.Worker = FakeWorker
  FakeWorker.manual = true
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    await assert.rejects(loadModel(MODEL, {}, undefined, AbortSignal.abort()), (error: unknown) => error instanceof DOMException && error.name === "AbortError")
    assert.equal(FakeWorker.created.length, 0, "no worker started")

    // The only waiter aborts mid-download.
    const heard: Array<number> = []
    const controller = new AbortController()
    const alone = loadModel(MODEL, {}, (value) => heard.push(value), controller.signal)
    const worker = FakeWorker.created[0]
    worker.reply({ type: "progress", cached: false, loadedBytes: 30, totalBytes: 100 })
    controller.abort()
    await assert.rejects(alone, { name: "AbortError" })
    assert.equal(worker.terminated, true, "the worker (and its download) ended")
    assert.deepEqual(heard, [0.3])
    assert.equal(await availability(MODEL), "downloadable")

    // Two waiters: one leaves, the other still hears progress and completion.
    const leaving: Array<number> = []
    const staying: Array<number> = []
    const leave = new AbortController()
    const first = loadModel(MODEL, {}, (value) => leaving.push(value), leave.signal)
    const second = loadModel(MODEL, {}, (value) => staying.push(value))
    const next = FakeWorker.created[1]
    next.reply({ type: "progress", cached: false, loadedBytes: 20, totalBytes: 100 })
    leave.abort()
    await assert.rejects(first, { name: "AbortError" })
    assert.equal(next.terminated, false)
    next.reply({ type: "progress", cached: false, loadedBytes: 70, totalBytes: 100 })
    next.reply({ type: "ready" })
    await second
    assert.deepEqual(leaving, [0.2])
    assert.deepEqual(staying, [0.2, 0.7, 1])
    assert.equal(await availability(MODEL), "available")

    // An embed call waiting on the load keeps it when the load's caller aborts.
    await unloadModel(MODEL)
    const session = new AbortController()
    const preload = loadModel(MODEL, {}, undefined, session.signal)
    const embedding = embedTexts(MODEL, {}, ["a"], OPTIONS)
    session.abort()
    await assert.rejects(preload, { name: "AbortError" })
    const third = FakeWorker.created[2]
    assert.equal(third.terminated, false)
    FakeWorker.manual = false
    third.reply({ type: "ready" })
    assert.equal((await embedding).length, 1)

    // Through the adapter, unawaited: no unhandled rejection.
    await unloadModel(MODEL)
    const ignored = new AbortController()
    void mediaPipeEmbedding(MODEL).createSessionWithProgress(undefined, { signal: ignored.signal })
    ignored.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("availability() makes no fetch, worker, Cache Storage, IndexedDB or OPFS calls", async () => {
  const calls: Array<string> = []
  const scope = globalThis as Record<string, unknown>
  const saved = Object.fromEntries(["fetch", "caches", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = Object.getOwnPropertyDescriptor(navigator, "storage")
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  define("fetch", async () => { calls.push("fetch"); throw new Error("no network") })
  define("caches", { open: async () => { calls.push("caches.open"); throw new Error("no") } })
  define("indexedDB", { open: () => { calls.push("indexedDB.open"); throw new Error("no") } })
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => { calls.push("navigator.storage.getDirectory"); return {} } } })
  scope.Worker = class extends FakeWorker { constructor() { super(); calls.push("new Worker") } }
  try {
    assert.equal(await availability(MODEL), "downloadable")
    assert.equal(await availability(MODEL, { cacheWasm: false, modelAssetPath: "https://example.com/model.tflite" }), "downloadable")
    assert.deepEqual(calls, [])
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    if (storage) Object.defineProperty(navigator, "storage", storage)
    else Reflect.deleteProperty(navigator, "storage")
  }
})

test("relative paths resolve against the page, not the worker's script", () => {
  const base = "https://example.com/review/index.html"
  const request = loadRequest(
    MODEL,
    { modelAssetPath: "./model.tflite", wasmPath: "/mediapipe/wasm/" },
    base
  )
  assert.equal(request.modelUrl, "https://example.com/review/model.tflite")
  assert.equal(request.wasmPath, "https://example.com/mediapipe/wasm/")
  assert.equal(request.delegate, "CPU")
  const defaults = loadRequest(MODEL, {}, base)
  assert.equal(defaults.wasmPath, MEDIAPIPE_WASM_URL)
  assert.equal(defaults.cacheWasm, true)
})
