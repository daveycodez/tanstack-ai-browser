import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { chat } from "@tanstack/ai"
import { WebGLLM, WebGLLMError } from "webgllm"

import { webgllmText } from "./adapter.js"
import { WEBGLLM_CHAT_MODELS, WEBGLLM_MODEL_REASONING } from "./catalog.js"
import { chunk, claim, collect, emit, fake, lastBody, MODEL, TIMINGS, textOptions, usageChunk } from "./fake-webgllm.test.js"
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

test("streams thinking then text as AG-UI events, with usage and webgllm's timings", async () => {
  fake.script = () => [
    chunk({ role: "assistant", reasoning_content: "Let me " }),
    chunk({ reasoning_content: "think." }),
    chunk({ content: "Paris" }),
    chunk({ content: "." }),
    chunk({}, "stop"),
    usageChunk({ prompt: 20, completion: 7, cached: 12, reasoning: 4 })
  ]
  const adapter = webgllmText(MODEL)
  const events = (await collect(adapter.chatStream(textOptions({ runId: "run-1" })))) as Array<Event>
  assert.deepEqual(types(events), [
    "RUN_STARTED",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_END",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ])
  const thinking = events.filter((e) => e.type === "REASONING_MESSAGE_CONTENT")
  assert.deepEqual(thinking.map((e) => e.delta), ["Let me ", "think."])
  const contents = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
  assert.deepEqual(contents.map((e) => [e.delta, e.content]), [["Paris", "Paris"], [".", "Paris."]])
  const finished = events.at(-1)!
  assert.equal(finished.runId, "run-1")
  assert.equal(finished.finishReason, "stop")
  assert.deepEqual(finished.usage, {
    promptTokens: 20,
    completionTokens: 7,
    totalTokens: 27,
    promptTokensDetails: { cachedTokens: 12 },
    completionTokensDetails: { reasoningTokens: 4 },
    providerUsageDetails: {
      firstTokenMs: TIMINGS.first_token_ms,
      promptMs: TIMINGS.prompt_ms,
      decodeMs: TIMINGS.decode_ms,
      promptTokensPerSecond: TIMINGS.prompt_tokens_per_second,
      decodeTokensPerSecond: TIMINGS.decode_tokens_per_second
    }
  })
  const body = lastBody()
  assert.equal(body.model, MODEL)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test("tool calls become TOOL_CALL events before the text ends, finishing with tool_calls", async () => {
  fake.script = () => [
    chunk({ content: "Checking." }),
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "lookup", arguments: '{"q":"b"}' } }] }),
    chunk({}, "tool_calls"),
    usageChunk()
  ]
  const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
  const events = (await collect(webgllmText(MODEL).chatStream(textOptions({ tools: [tool] })))) as Array<Event>
  assert.deepEqual(types(events), [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_END",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ])
  const ends = events.filter((e) => e.type === "TOOL_CALL_END")
  assert.deepEqual(ends.map((e) => [e.toolCallId, e.toolCallName, e.args, e.input]), [
    ["call_a", "lookup", '{"q":"a"}', { q: "a" }],
    ["call_b", "lookup", '{"q":"b"}', { q: "b" }]
  ])
  const start = events.find((e) => e.type === "TOOL_CALL_START")!
  assert.equal(start.parentMessageId, events.find((e) => e.type === "TEXT_MESSAGE_START")!.messageId)
  assert.equal(events.at(-1)!.finishReason, "tool_calls")
  assert.deepEqual(lastBody().tools, [
    { type: "function", function: { name: "lookup", description: "Look up", parameters: tool.inputSchema } }
  ])
})

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

test("a non-zero frequencyPenalty throws webgllm's unsupported-parameter error before any request", async () => {
  await assert.rejects(
    collect(webgllmText(MODEL).chatStream(textOptions({ modelOptions: { frequencyPenalty: 0.5 } }))),
    (error: unknown) => error instanceof WebGLLMError && error.code === "unsupported-parameter"
  )
  assert.equal(fake.requests.length, 0)
})

test("invalid budgets and output caps throw before any request", async () => {
  const adapter = webgllmText(MODEL)
  await assert.rejects(
    collect(adapter.chatStream(textOptions({ reasoning: { level: "high", summary: true, budgetTokens: -1 } }))),
    RangeError
  )
  await assert.rejects(collect(adapter.chatStream(textOptions({ modelOptions: { maxCompletionTokens: 1.5 } }))), RangeError)
  assert.equal(fake.requests.length, 0)
  assert.equal(fake.loads.length, 0)
})

test("the conversation maps to OpenAI messages: system prompts, tool calls, results and thinking", async () => {
  await collect(
    webgllmText(MODEL).chatStream(
      textOptions({
        systemPrompts: ["Be brief.", "Use tools."],
        messages: [
          { role: "user", content: [{ type: "text", content: "Look " }, { type: "text", content: "up a" }] },
          {
            role: "assistant",
            content: "",
            thinking: [{ content: "I should " }, { content: "look." }],
            toolCalls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }]
          },
          { role: "tool", content: '{"value":1}', toolCallId: "c1" },
          { role: "tool", content: "", toolCallId: "c2", error: "Not found" }
        ]
      })
    )
  )
  assert.deepEqual(lastBody().messages, [
    { role: "system", content: "Be brief.\n\nUse tools." },
    { role: "user", content: "Look up a" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "I should look.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }]
    },
    { role: "tool", content: '{"value":1}', tool_call_id: "c1" },
    { role: "tool", content: "Error: Not found", tool_call_id: "c2" }
  ])
})

test("a webgllm failure mid-stream ends the text and emits RUN_ERROR with its code", async () => {
  fake.script = () => [
    chunk({ content: "Par" }),
    new WebGLLMError("context-length-exceeded", "The chat is longer than the context.")
  ]
  const events = (await collect(webgllmText(MODEL).chatStream(textOptions()))) as Array<Event>
  assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_ERROR"])
  const error = events.at(-1)!
  assert.equal(error.message, "The chat is longer than the context.")
  assert.equal(error.code, "context-length-exceeded")
  assert.equal(error.errorType, "context-length-exceeded")
  assert.deepEqual(error.error, { message: "The chat is longer than the context.", code: "context-length-exceeded" })
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

test("aborting mid-stream closes open messages and ends without RUN_FINISHED or RUN_ERROR", async () => {
  const controller = new AbortController()
  let release!: () => void
  const paused = new Promise<void>((resolve) => (release = resolve))
  fake.script = () => [chunk({ reasoning_content: "hmm" }), { wait: paused }, chunk({ content: "never" }), chunk({}, "stop")]
  const events: Array<Event> = []
  for await (const event of webgllmText(MODEL).chatStream(textOptions({ abortController: controller }))) {
    events.push(event as Event)
    if ((event as Event).type === "REASONING_MESSAGE_CONTENT") {
      controller.abort()
      release()
    }
  }
  assert.deepEqual(types(events), [
    "RUN_STARTED",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_END"
  ])
  assert.equal(fake.requests[0]!.options.signal, controller.signal, "the signal reaches webgllm, which stops the generation")
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

test("availability() makes no fetch, worker, storage or webgllm calls", async () => {
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
    assert.deepEqual(fake.retrieved, [], "no models.retrieve (it fetches file sizes from Hugging Face)")
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

test("availability (downloadable until loaded, available once ready) and download progress follow loads, progress, unloads and failures", async () => {
  const adapter = webgllmText(MODEL, { contextLength: 4096 })
  const other = webgllmText(MODEL, { contextLength: 4096 })
  assert.equal(await adapter.availability(), "downloadable")
  let open!: () => void
  fake.loadGate = new Promise<void>((resolve) => (open = resolve))
  const progress: Array<number> = []
  const loading = adapter.createSessionWithProgress((value) => progress.push(value))
  await new Promise((resolve) => setTimeout(resolve, 0))
  emit("progress", { model: MODEL, phase: "download", progress: 0.36, cached: false, loadedBytes: 4, totalBytes: 10 })
  emit("progress", { model: MODEL, phase: "download", progress: 0.9, cached: false })
  emit("progress", { model: MODEL, phase: "load", progress: 0.95, cached: false })
  assert.equal(await other.availability(), "downloadable", "a load in progress isn't \"downloading\": progress comes from the callback")
  open()
  assert.equal(await loading, adapter)
  assert.deepEqual(progress, [0.4, 1, 1], "the download's share, then 1 once ready")
  assert.equal(await adapter.availability(), "available")
  assert.equal(await other.availability(), "available", "adapters of one model share it")
  assert.deepEqual(fake.loads.at(-1)?.options, { contextLength: 4096, keepLoaded: false })

  // The same context is already loaded: it reports 1 at once; another loads it again.
  const late: Array<number> = []
  await other.createSessionWithProgress((value) => late.push(value))
  assert.deepEqual(late, [1])
  assert.equal(fake.loads.length, 1)
  await loadModel(MODEL, { contextLength: 8192 })
  assert.equal(fake.loads.length, 2)

  await other.destroySession()
  assert.deepEqual(fake.unloads, [MODEL], "unloading through one adapter unloads the shared model")
  assert.equal(await adapter.availability(), "downloadable", "unloaded: its files may be stored, but it isn't loaded")

  fake.loadError = new Error("GPU lost")
  await assert.rejects(adapter.createSessionWithProgress(), /GPU lost/)
  void adapter.createSessionWithProgress()
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
  assert.equal(await availability(MODEL), "downloadable")
  emit("progress", { model: MODEL, phase: "load", progress: 0.95, cached: false })
  emit("load", { model: MODEL, contextLength: 32_768 })
  assert.equal(await availability(MODEL), "downloadable")
  await loadModel(MODEL)
  assert.equal(fake.loads.length, 1, "the loader loads it for the requested context")
  assert.equal(await availability(MODEL), "available")
})

test("availability is keyed on the context length as the loader is: another context isn't available until loaded for it", async () => {
  await loadModel(MODEL, { contextLength: 8192 })
  assert.equal(await webgllmText(MODEL, { contextLength: 8192 }).availability(), "available")
  assert.equal(await webgllmText(MODEL, { contextLength: 16_384 }).availability(), "downloadable")
  assert.equal(await webgllmText(MODEL).availability(), "downloadable", "the model's own context is another")
  await webgllmText(MODEL, { contextLength: 16_384 }).createSessionWithProgress()
  assert.equal(fake.loads.length, 2, "the loader loaded it again for 16,384")
  assert.equal(await webgllmText(MODEL, { contextLength: 16_384 }).availability(), "available")
  assert.equal(await webgllmText(MODEL, { contextLength: 8192 }).availability(), "downloadable")
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

test("waiters sharing one progress callback: one leaving keeps it for the other, which still hears progress and completion", async () => {
  let open!: () => void
  fake.loadGate = new Promise<void>((resolve) => (open = resolve))
  const heard: Array<number> = []
  const onProgress = (value: number) => heard.push(value)
  const controller = new AbortController()
  const leaving = ensureModel(MODEL, undefined, controller.signal, onProgress)
  const staying = ensureModel(MODEL, undefined, undefined, onProgress)
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
