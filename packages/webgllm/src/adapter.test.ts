/**
 * The adapter's runtime methods over webgllm: availability, create with
 * its download progress, destroy, the backend option, predictSpeed, and the
 * catalog's reasoning data.
 */
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { WebGLLM } from "webgllm"
import type { LoadProgress } from "webgllm"

import { speed, webgllm, webgllmText } from "./adapter.js"
import { WEBGLLM_MODEL_REASONING } from "./catalog.js"
import { fake, MODEL } from "./fake-webgllm.test.js"

// Node has no WebGL 2: the engine counts as supported here (unavailable.test.ts has the other case).
;(WebGLLM as unknown as { isSupported: () => boolean }).isSupported = () => true
beforeEach(() => fake.reset())

const download = (loadedBytes: number, extra: Partial<LoadProgress> = {}): LoadProgress =>
  ({ model: MODEL, phase: "download", progress: (loadedBytes / 100) * 0.9, loadedBytes, totalBytes: 100, cached: false, ...extra }) as LoadProgress

test("availability: downloadable, downloading during a download, available once loaded or stored", async () => {
  const adapter = webgllmText(MODEL)
  assert.equal(await adapter.availability(), "downloadable")
  let release!: () => void
  fake.loadGate = new Promise((resolve) => (release = resolve))
  fake.progress = [download(40)]
  const loading = adapter.create()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(await adapter.availability(), "downloading")
  release()
  await loading
  assert.equal(await adapter.availability(), "available")
  await adapter.destroy()
  assert.equal(await adapter.availability(), "downloadable")
  fake.stored.add(MODEL)
  assert.equal(await adapter.availability(), "available")
})

test("create loads for the adapter's context length; progress (the download's share, then 1) reaches both callbacks", async () => {
  const own: Array<number> = []
  const theirs: Array<number> = []
  fake.progress = [download(50), download(50, { cached: true }), download(100)]
  const adapter = webgllmText(MODEL, { contextLength: 2048, onDownloadProgress: (p) => own.push(p) })
  assert.equal(await adapter.create({ onDownloadProgress: (p) => theirs.push(p) }), adapter)
  assert.equal(fake.loads.at(-1)?.options.contextLength, 2048)
  assert.deepEqual(own, [0.5, 1, 1])
  assert.deepEqual(theirs, [0.5, 1, 1])
})

test("create rejects when the load fails or its signal aborts, and is safe to leave unawaited", async () => {
  fake.loadError = new Error("No room for the model.")
  await assert.rejects(webgllmText(MODEL).create(), /No room/)
  fake.loadError = undefined
  fake.loadGate = new Promise(() => undefined)
  const controller = new AbortController()
  const pending = webgllmText(MODEL).create({ signal: controller.signal })
  controller.abort()
  await assert.rejects(pending)
  void webgllmText(MODEL).create({ signal: AbortSignal.abort() })
})

test("destroy unloads the model and never rejects", async () => {
  await webgllmText(MODEL).create()
  await webgllmText(MODEL).destroy()
  assert.deepEqual(fake.unloads, [MODEL])
  assert.equal(fake.loaded.has(MODEL), false)
})

test("WEBGLLM_MODEL_REASONING has every model, in TanStack's shape", () => {
  const reasoning = WEBGLLM_MODEL_REASONING[MODEL]
  assert.ok(reasoning)
  assert.equal(reasoning.levels.high, "high")
  assert.equal(reasoning.levels.off, "none")
  assert.equal(reasoning.budget, true)
})

// Compile-time: each model's reasoning is exact (typecheck fails if it widens again).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const exact = <T extends true>(value: T) => value
type Thinkers = keyof import("./catalog.js").WebGllmModelReasoningByName
exact<Equal<Thinkers,
  | "LiquidAI/LFM3-1.7B-GGUF"
  | "onnx-community/LFM3-1.7B-ONNX"
  | "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"
  | "LiquidAI/LFM2.5-1.2B-Thinking-GGUF"
  | "LiquidAI/LFM3-VL-2B-GGUF"
  | "LiquidAI/LFM3-VL-2B-ONNX"
  | "unsloth/Qwen3.5-2B-GGUF"
  | "onnx-community/Qwen3.5-2B-ONNX">>(true)

test("a worker of your own has a WebGLLM of its own, shared by the adapters given it", async () => {
  const worker = { postMessage: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Worker
  type WithEngine = { engine: { webgllm: unknown } }
  const first = webgllmText(MODEL, { worker }) as unknown as WithEngine
  const second = webgllmText(MODEL, { worker }) as unknown as WithEngine
  const page = webgllmText(MODEL) as unknown as WithEngine
  assert.equal(first.engine.webgllm, second.engine.webgllm)
  assert.notEqual(first.engine.webgllm, page.engine.webgllm)
  assert.ok(first.engine.webgllm instanceof WebGLLM)
})

test("webgpu: adapters on WebGL 2 share a WebGLLM of their own in the page; \"auto\" is the default one; anything else throws", () => {
  type WithEngine = { engine: { webgllm: unknown } }
  const auto = webgllmText(MODEL, { webgpu: "auto" }) as unknown as WithEngine
  const plain = webgllmText(MODEL) as unknown as WithEngine
  const gl = webgllmText(MODEL, { webgpu: false }) as unknown as WithEngine
  const gl2 = webgllmText("LiquidAI/LFM2.5-350M-GGUF", { webgpu: false }) as unknown as WithEngine
  assert.equal(auto.engine.webgllm, webgllm)
  assert.equal(plain.engine.webgllm, webgllm)
  assert.equal(gl.engine.webgllm, gl2.engine.webgllm)
  assert.notEqual(gl.engine.webgllm, webgllm)
  assert.ok(gl.engine.webgllm instanceof WebGLLM)
  for (const value of [true, "false", "webgl"]) assert.throws(() => webgllmText(MODEL, { webgpu: value as never }), /webgpu must be "auto" or false/)
})

test("webgpu: adapters given the same worker must agree on it", () => {
  const worker = { postMessage: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Worker
  webgllmText(MODEL, { worker, webgpu: false })
  assert.doesNotThrow(() => webgllmText("LiquidAI/LFM2.5-350M-GGUF", { worker, webgpu: false }))
  assert.throws(() => webgllmText(MODEL, { worker }), /same worker/)
})

test("predictSpeed asks webgllm for the adapter's model, with its options and the adapter's backend", async () => {
  const calls: Array<{ model: string; options: unknown }> = []
  const original = speed.predict
  speed.predict = (async (model: string, options: unknown) => {
    calls.push({ model, options })
    return { prompt: 360, decode: 42 }
  }) as typeof speed.predict
  try {
    assert.deepEqual(await webgllmText(MODEL).predictSpeed(), { prompt: 360, decode: 42 })
    const signal = new AbortController().signal
    await webgllmText(MODEL, { webgpu: false }).predictSpeed({ decode: false, force: true, signal })
    assert.deepEqual(calls, [
      { model: MODEL, options: {} },
      { model: MODEL, options: { decode: false, force: true, signal, webgpu: false } }
    ])
  } finally {
    speed.predict = original
  }
})
