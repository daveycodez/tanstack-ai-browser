import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { embedTexts, loadModel, loadRequest, modelStatus, unloadModel } from "./client.js"
import type { WorkerRequest, WorkerResponse } from "./protocol.js"
import { MEDIAPIPE_WASM_URL } from "./version.js"

const MODEL = "universal-sentence-encoder"
const OPTIONS = { l2Normalize: false, quantize: false }

/** A stand-in for the embedder's worker: loads after a tick, embeds after another. */
class FakeWorker {
  static created: Array<FakeWorker> = []
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
      setTimeout(() => this.reply({ type: "ready" }), 5)
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
  assert.equal(modelStatus(MODEL).get().state, "ready")
})

test("a Worker the browser refuses to create leaves an error status, and loadModel rejects", async () => {
  globals.Worker = class {
    constructor() {
      throw new DOMException("Worker blocked", "SecurityError")
    }
  }
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    await assert.rejects(loadModel(MODEL), /Worker blocked/)
    const status = modelStatus(MODEL).get()
    assert.equal(status.state, "error")
    assert.match(status.state === "error" ? status.message : "", /Worker blocked/)
    await assert.rejects(embedTexts(MODEL, {}, ["x"], OPTIONS), /Worker blocked/)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  // The next load starts afresh.
  globals.Worker = FakeWorker
  await loadModel(MODEL)
  assert.equal(modelStatus(MODEL).get().state, "ready")
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
