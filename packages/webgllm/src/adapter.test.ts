import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { chat } from "@tanstack/ai"
import { WebGLLM, WebGLLMError } from "webgllm"

import { webgllmText } from "./adapter.js"
import { WEBGLLM_CHAT_MODELS, WEBGLLM_MODEL_REASONING } from "./catalog.js"
import { chunk, claim, collect, emit, fake, lastBody, MODEL, textOptions, usageChunk } from "./fake-webgllm.test.js"
import { availability, ensureModel, forgetEngineCheck, loadModel, setKeepLoaded, setMemoryBudget, unloadModel } from "./models.js"

// Node has no WebGL 2: the engine counts as supported here, but for the test that says otherwise.
const engine = WebGLLM as unknown as { isSupported: () => boolean }
const supported = engine.isSupported
beforeEach(() => {
  fake.reset()
  engine.isSupported = () => true
  forgetEngineCheck()
})

type Event = { type: string } & Record<string, unknown>
const types = (events: Array<unknown>) => (events as Array<Event>).map((e) => e.type)

test("model options (OpenRouter's names), reasoning and prompt cache map onto the request", async () => {
  const adapter = webgllmText(MODEL)
  await collect(
    adapter.chatStream(
      textOptions({
        reasoning: { level: "high", summary: true, budgetTokens: 256 },
        promptCache: { retention: "none" },
        modelOptions: {
          maxCompletionTokens: 300,
          temperature: 0.2,
          topP: 0.9,
          presencePenalty: 0.5,
          frequencyPenalty: 0,
          stop: ["END"],
          seed: 7,
          topK: 20,
          minP: 0.05,
          repetitionPenalty: 1.1,
          parallelToolCalls: false,
          repairToolCalls: false
        },
        tools: [{ name: "lookup", description: "Look up" }]
      })
    )
  )
  const body = lastBody()
  assert.equal(body.reasoning_effort, "high")
  assert.equal(body.thinking_budget_tokens, 256)
  assert.equal(body.cache_prompt, false)
  assert.equal(body.max_completion_tokens, 300)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.top_p, 0.9)
  assert.equal(body.top_k, 20)
  assert.equal(body.min_p, 0.05)
  assert.equal(body.repetition_penalty, 1.1)
  assert.equal(body.presence_penalty, 0.5)
  assert.equal("frequency_penalty" in body, false, "a zero frequencyPenalty isn't sent")
  assert.deepEqual(body.stop, ["END"])
  assert.equal(body.seed, 7)
  assert.equal(body.parallel_tool_calls, false)
  assert.equal(body.repair_tool_calls, false)

  // Off turns thinking off and ignores a valid cap; no request leaves the template's default.
  await collect(adapter.chatStream(textOptions({ reasoning: { level: "off", summary: true, budgetTokens: 256 } })))
  assert.equal(lastBody().reasoning_effort, "none")
  assert.equal("thinking_budget_tokens" in lastBody(), false)
  await collect(adapter.chatStream(textOptions()))
  for (const key of ["reasoning_effort", "thinking_budget_tokens", "cache_prompt", "max_completion_tokens", "temperature", "top_p", "seed"]) {
    assert.equal(key in lastBody(), false, `${key} isn't sent unless asked for`)
  }
})

test("a failed load emits RUN_ERROR, and the model isn't counted as loaded", async () => {
  fake.loadError = new WebGLLMError("download-failed", "Network down.")
  const events = (await collect(webgllmText(MODEL).chatStream(textOptions()))) as Array<Event>
  assert.deepEqual(types(events), ["RUN_STARTED", "RUN_ERROR"])
  assert.equal(events[1]!.message, `Couldn't load ${MODEL}: Network down.`)
  assert.equal(events[1]!.code, "download-failed")
  assert.equal(await availability(MODEL), "downloadable")
  assert.equal(fake.requests.length, 0)
})

test("an already aborted request yields nothing; leaving the stream early stops webgllm's", async () => {
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await collect(webgllmText(MODEL).chatStream(textOptions({ abortController: controller }))), [])
  assert.equal(fake.requests.length, 0)

  fake.script = () => [chunk({ content: "a" }), chunk({ content: "b" }), chunk({ content: "c" }), chunk({}, "stop")]
  for await (const event of webgllmText(MODEL).chatStream(textOptions())) {
    if ((event as Event).type === "TEXT_MESSAGE_CONTENT") break
  }
  assert.equal(fake.returned, 1)
})

test("works under chat(): a non-streaming answer", async () => {
  fake.script = () => [chunk({ content: "Bonjour" }), chunk({}, "stop"), usageChunk()]
  const answer = await chat({ adapter: webgllmText(MODEL), threadId: "chat", messages: [{ role: "user", content: "hi" }], stream: false })
  assert.equal(answer.text, "Bonjour")
})

test("availability: unavailable where the engine can't run or for a model it doesn't list", async () => {
  engine.isSupported = supported
  assert.equal(await webgllmText(MODEL).availability(), "unavailable", "no WebGL 2 in Node")
  engine.isSupported = () => true
  assert.equal(await availability("not/a-model" as typeof MODEL), "unavailable")
})

test("availability() reads storage only (models.downloaded): no fetch, worker, models.retrieve or models.list", async () => {
  const calls: Array<string> = []
  const saved = Object.fromEntries(["fetch", "caches", "indexedDB", "Worker"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = Object.getOwnPropertyDescriptor(navigator, "storage")
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  define("fetch", async () => { calls.push("fetch"); throw new Error("no network") })
  define("caches", { open: async () => { calls.push("caches.open"); throw new Error("no") } })
  define("indexedDB", { open: () => { calls.push("indexedDB.open"); throw new Error("no") } })
  define("Worker", class { constructor() { calls.push("new Worker") } })
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => { calls.push("navigator.storage.getDirectory"); return {} } } })
  try {
    assert.equal(await webgllmText(MODEL).availability(), "downloadable")
    await loadModel(MODEL)
    const before = fake.loads.length
    assert.equal(await webgllmText(MODEL).availability(), "available")
    assert.equal(fake.loads.length, before)
    assert.deepEqual(fake.retrieved, [], "no models.retrieve or models.list (they fetch from Hugging Face)")
    assert.ok(fake.downloadedAsked.length > 0, "storage asked through models.downloaded")
    assert.equal(fake.requests.length, 0)
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

test("availability (downloadable, downloading during the download, available once ready) and download progress follow loads, progress, unloads and failures", async () => {
  const adapter = webgllmText(MODEL, { contextLength: 4096 })
  const other = webgllmText(MODEL, { contextLength: 4096 })
  assert.equal(await adapter.availability(), "downloadable")
  let open!: () => void
  fake.loadGate = new Promise<void>((resolve) => (open = resolve))
  const progress: Array<number> = []
  const loading = adapter.create({ onDownloadProgress: (value) => progress.push(value) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  emit("progress", { model: MODEL, phase: "download", progress: 0.36, cached: false, loadedBytes: 4, totalBytes: 10 })
  emit("progress", { model: MODEL, phase: "download", progress: 0.9, cached: false })
  emit("progress", { model: MODEL, phase: "load", progress: 0.95, cached: false })
  assert.equal(await other.availability(), "downloading", "adapters of one model share its download")
  open()
  assert.equal(await loading, adapter)
  assert.deepEqual(progress, [0.4, 1, 1], "the download's share, then 1 once ready")
  assert.equal(await adapter.availability(), "available")
  assert.equal(await other.availability(), "available", "adapters of one model share it")
  assert.deepEqual(fake.loads.at(-1)?.options, { contextLength: 4096, keepLoaded: false })

  // The same context is already loaded: it reports 1 at once; another loads it again.
  const late: Array<number> = []
  await other.create({ onDownloadProgress: (value) => late.push(value) })
  assert.deepEqual(late, [1])
  assert.equal(fake.loads.length, 1)
  await loadModel(MODEL, { contextLength: 8192 })
  assert.equal(fake.loads.length, 2)

  await other.destroy()
  assert.deepEqual(fake.unloads, [MODEL], "unloading through one adapter unloads the shared model")
  assert.equal(await adapter.availability(), "downloadable", "unloaded: its files may be stored, but it isn't loaded")

  fake.loadError = new Error("GPU lost")
  await assert.rejects(adapter.create(), /GPU lost/)
  void adapter.create()
})

test("the adapter loads for its own context length, reporting progress from its config", async () => {
  const progress: Array<number> = []
  const adapter = webgllmText(MODEL, { contextLength: 2048, keepLoaded: true, onDownloadProgress: (value) => progress.push(value) })
  await collect(adapter.chatStream(textOptions()))
  assert.deepEqual(fake.loads.map((l) => l.options), [{ contextLength: 2048, keepLoaded: true }])
  assert.deepEqual(progress, [1])
  assert.equal(await adapter.availability(), "available")
  await collect(adapter.chatStream(textOptions()))
  assert.equal(fake.loads.length, 1, "loaded once for its context")
  assert.deepEqual(progress, [1], "a loaded model reports nothing more")
  setKeepLoaded(MODEL, false)
})

test("a load webgllm starts on its own isn't one for any adapter's context: availability and the loader agree it loads again", async () => {
  // A completion loading its model on demand: webgllm dispatches the events.
  emit("loadstart", { model: MODEL })
  emit("progress", { model: MODEL, phase: "download", progress: 0.5, cached: false })
  assert.equal(await availability(MODEL), "downloading")
  emit("progress", { model: MODEL, phase: "load", progress: 0.95, cached: false })
  emit("load", { model: MODEL, contextLength: 32_768 })
  assert.equal(await availability(MODEL), "downloadable")
  await loadModel(MODEL)
  assert.equal(fake.loads.length, 1, "the loader loads it for the requested context")
  assert.equal(await availability(MODEL), "available")
})

test("availability: loaded for the adapter's context, or its files in webgllm's storage, is available; storage cleared, downloadable", async () => {
  assert.equal(await webgllmText(MODEL).availability(), "downloadable")
  fake.stored.add(MODEL)
  assert.equal(await webgllmText(MODEL).availability(), "available", "on the device: models.downloaded")
  fake.stored.delete(MODEL)
  assert.equal(await webgllmText(MODEL).availability(), "downloadable", "a cleared storage needs the download again")
  await loadModel(MODEL, { contextLength: 8192 })
  assert.equal(await webgllmText(MODEL, { contextLength: 8192 }).availability(), "available")
  assert.equal(await webgllmText(MODEL, { contextLength: 16_384 }).availability(), "available", "loaded at another context: its files are on the device")
  await webgllmText(MODEL, { contextLength: 16_384 }).create()
  assert.equal(fake.loads.length, 2, "the loader loaded it again for 16,384")
  assert.equal(await webgllmText(MODEL, { contextLength: 16_384 }).availability(), "available")
  assert.equal(await webgllmText(MODEL, { contextLength: 8192 }).availability(), "available", "its files are still on the device")
})

test("one engine check per page, however many models and calls ask", async () => {
  let probes = 0
  engine.isSupported = () => { probes++; return true }
  assert.ok(WEBGLLM_CHAT_MODELS.length > 2)
  for (const model of WEBGLLM_CHAT_MODELS) {
    assert.equal(await webgllmText(model).availability(), "downloadable")
    assert.equal(await availability(model, 4096), "downloadable")
  }
  assert.equal(probes, 1)
})

test("create's signal: aborted before, nothing loads; the only waiter aborting cancels the load; one of two leaving keeps it for the other; a chat waiting keeps it too", async () => {
  const adapter = webgllmText(MODEL)
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    await assert.rejects(adapter.create({ signal: AbortSignal.abort() }), (error: unknown) => error instanceof DOMException && error.name === "AbortError")
    assert.equal(fake.loads.length, 0, "nothing loaded")

    // The only waiter aborts mid-download.
    let open!: () => void
    fake.loadGate = new Promise<void>((resolve) => (open = resolve))
    const heard: Array<number> = []
    const controller = new AbortController()
    const alone = adapter.create({ onDownloadProgress: (value) => heard.push(value), signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    emit("progress", { model: MODEL, phase: "download", progress: 0.27, cached: false, loadedBytes: 3, totalBytes: 10 })
    controller.abort()
    await assert.rejects(alone, { name: "AbortError" })
    assert.deepEqual(heard, [0.3], "nothing more after the abort")
    open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fake.loaded.has(MODEL), false, "the load was cancelled: the model isn't loaded")
    assert.equal(await adapter.availability(), "downloadable")

    // Two waiters: one leaves, the other still hears progress and completion.
    fake.loadGate = new Promise<void>((resolve) => (open = resolve))
    const leaving: Array<number> = []
    const staying: Array<number> = []
    const leave = new AbortController()
    const first = adapter.create({ onDownloadProgress: (value) => leaving.push(value), signal: leave.signal })
    const second = adapter.create({ onDownloadProgress: (value) => staying.push(value) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    emit("progress", { model: MODEL, phase: "download", progress: 0.18, cached: false, loadedBytes: 2, totalBytes: 10 })
    leave.abort()
    await assert.rejects(first, { name: "AbortError" })
    emit("progress", { model: MODEL, phase: "download", progress: 0.63, cached: false, loadedBytes: 7, totalBytes: 10 })
    open()
    assert.equal(await second, adapter)
    assert.deepEqual(leaving, [0.2])
    assert.deepEqual(staying, [0.2, 0.7, 1])
    assert.equal(await adapter.availability(), "available")

    // A chat waiting on the load keeps it when a session caller aborts.
    await adapter.destroy()
    fake.loadGate = new Promise<void>((resolve) => (open = resolve))
    const session = new AbortController()
    const preload = adapter.create({ signal: session.signal })
    const chat = ensureModel(MODEL, undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.abort()
    await assert.rejects(preload, { name: "AbortError" })
    open()
    await chat
    assert.equal(await adapter.availability(), "available")

    await adapter.destroy()
    const ignored = new AbortController()
    void adapter.create({ signal: ignored.signal })
    ignored.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("constructing an adapter changes nothing shared; keepLoaded applies when it uses the model, and an adapter without it leaves another's", async () => {
  const keeper = webgllmText(MODEL, { keepLoaded: true })
  const plain = webgllmText(MODEL)
  try {
    await plain.create()
    assert.equal(fake.loads.at(-1)?.options.keepLoaded, false, "constructing the keepLoaded adapter changed nothing")
    await plain.destroy()
    await keeper.create()
    assert.equal(fake.loads.at(-1)?.options.keepLoaded, true, "using it applies it")
    await keeper.destroy()
    await webgllmText(MODEL).create()
    assert.equal(fake.loads.at(-1)?.options.keepLoaded, true, "a later adapter without keepLoaded leaves it")
  } finally {
    setKeepLoaded(MODEL, false)
  }
})

test("waiters sharing one progress callback: one leaving keeps it for the other, which still hears progress and completion", async () => {
  let open!: () => void
  fake.loadGate = new Promise<void>((resolve) => (open = resolve))
  const heard: Array<number> = []
  const callback = (value: number) => heard.push(value)
  const controller = new AbortController()
  const leaving = ensureModel(MODEL, undefined, controller.signal, callback)
  const staying = ensureModel(MODEL, undefined, undefined, callback)
  await new Promise((resolve) => setTimeout(resolve, 0))
  emit("progress", { model: MODEL, phase: "download", progress: 0.18, cached: false, loadedBytes: 2, totalBytes: 10 })
  controller.abort()
  await assert.rejects(leaving, { name: "AbortError" })
  emit("progress", { model: MODEL, phase: "download", progress: 0.45, cached: false, loadedBytes: 5, totalBytes: 10 })
  open()
  await staying
  assert.deepEqual(heard, [0.2, 0.5, 1], "each report once, and the completion, after the other waiter left")
})

test("evictions and crashes reach availability as they happen", async () => {
  await loadModel(MODEL)
  assert.equal(await availability(MODEL), "available")
  // webgllm's own budget unloads it to make room.
  emit("unload", { model: MODEL, reason: "evicted" })
  assert.equal(await availability(MODEL), "downloadable")
  await loadModel(MODEL)
  emit("error", { model: MODEL, error: new Error("worker stopped") })
  emit("unload", { model: MODEL, reason: "crashed" })
  assert.equal(await availability(MODEL), "downloadable")
  // Loading again after an unload loads it again (nothing thinks it's still loaded).
  const before = fake.loads.length
  await loadModel(MODEL)
  assert.equal(fake.loads.length, before + 1)
  assert.equal(await availability(MODEL), "available")
})

test("the shared memory registry: holds what webgllm's workers claim, makes room across runtimes, and evicts through webgllm", async () => {
  type Held = { owner: string; bytes: number; keepLoaded: boolean; unload: () => unknown; lastUsed: number }
  const registry = (globalThis as unknown as Record<symbol, { held: Map<string, Held>; budget?: number }>)[
    Symbol.for("@tanstack-ai-browser/model-memory")
  ]!
  setMemoryBudget(2e9)
  let otherUnloaded = false
  registry.held.set("wllama", {
    owner: "wllama",
    bytes: 1e9,
    keepLoaded: false,
    lastUsed: 0,
    unload: () => (otherUnloaded = true)
  } as Held)
  try {
    await loadModel(MODEL)
    const held = registry.held.get(`webgllm:${MODEL}`)
    assert.equal(held?.bytes, 1.4e9, "the bytes the worker claimed")
    assert.equal(otherUnloaded, true, "the other runtime's model made room")

    // Another runtime claims past the budget: this model is unloaded through webgllm.
    const { claimMemory } = await import("./model-memory.js")
    await claimMemory({ owner: "transformers-js", model: "x", bytes: 1.5e9, keepLoaded: false, unload: () => undefined })
    assert.deepEqual(fake.unloads, [MODEL])
    assert.equal(registry.held.has(`webgllm:${MODEL}`), false)
  } finally {
    registry.held.delete("transformers-js")
    registry.held.delete("wllama")
    setMemoryBudget(undefined)
  }
})

test("WEBGLLM_MODEL_REASONING has every model, in TanStack's shape", () => {
  const reasoning = WEBGLLM_MODEL_REASONING[MODEL]
  assert.ok(reasoning)
  assert.equal(reasoning.levels.high, "true")
  assert.equal(reasoning.levels.off, "false")
  assert.equal(reasoning.budget, true)
})

// Compile-time: each model's reasoning is exact (typecheck fails if it widens again).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const exact = <T extends true>(_: T) => undefined
type Thinkers = keyof import("./catalog.js").WebGllmModelReasoningByName
exact<Equal<Thinkers,
  | "LiquidAI/LFM3-1.7B-GGUF"
  | "onnx-community/LFM3-1.7B-ONNX"
  | "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"
  | "LiquidAI/LFM2.5-1.2B-Thinking-GGUF"
  | "unsloth/Qwen3.5-2B-GGUF"
  | "onnx-community/Qwen3.5-2B-ONNX">>(true)

const registryHeld = () =>
  (globalThis as unknown as Record<symbol, { held: Map<string, { bytes: number }> }>)[Symbol.for("@tanstack-ai-browser/model-memory")]!.held

test("a cache that grows claims its bytes in the registry first, making room in another runtime", async () => {
  const held = registryHeld()
  setMemoryBudget(2e9)
  let otherUnloaded = false
  try {
    await loadModel(MODEL)
    held.set("transformers-js", { owner: "transformers-js", model: "x", bytes: 0.5e9, keepLoaded: false, lastUsed: Date.now(), unload: () => (otherUnloaded = true) } as never)
    // The worker's attention cache grows past what's left: the other runtime makes room before it allocates.
    await claim(MODEL, 1.8e9)
    assert.equal(held.get(`webgllm:${MODEL}`)?.bytes, 1.8e9)
    assert.equal(otherUnloaded, true)
    assert.equal(held.has("transformers-js"), false)
  } finally {
    held.delete("transformers-js")
    setMemoryBudget(undefined)
  }
})

test("one of two callers giving up leaves the shared load, and its memory claim, to the other", async () => {
  const held = registryHeld()
  let open!: () => void
  fake.loadGate = new Promise<void>((resolve) => (open = resolve))
  const controller = new AbortController()
  const first = ensureModel(MODEL, undefined, controller.signal)
  const second = ensureModel(MODEL, undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(first, { name: "AbortError" })
  open()
  await second
  assert.equal(await availability(MODEL), "available")
  assert.equal(held.get(`webgllm:${MODEL}`)?.bytes, 1.4e9, "the loaded model's memory is still counted")
})

test("unloading a model just after asking for it stops that load: nothing waits before webgllm takes it", async () => {
  const held = registryHeld()
  // A player switching opponents at once.
  const loading = loadModel(MODEL)
  await unloadModel(MODEL)
  await assert.rejects(loading)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.loaded.has(MODEL), false, "the old model never loaded")
  assert.equal(held.has(`webgllm:${MODEL}`), false, "and holds no memory")
  assert.equal(await availability(MODEL), "downloadable")
})

test("unloading a model while its load waits for room never lets the old load go on", async () => {
  const held = registryHeld()
  let open!: () => void
  fake.claimGate = new Promise<void>((resolve) => (open = resolve))
  const loading = loadModel(MODEL)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await unloadModel(MODEL)
  open()
  await assert.rejects(loading)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.loaded.has(MODEL), false, "the old model never loaded")
  assert.equal(held.has(`webgllm:${MODEL}`), false, "and holds no memory")
  assert.equal(await availability(MODEL), "downloadable")
})
