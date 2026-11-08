import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

import { wllamaText } from "./adapter.js"
import { modelUrl } from "./catalog.js"

const MODEL = "LiquidAI/LFM2.5-350M-GGUF"

test("on a server, which has no Web Worker or Origin Private File System, the model is unavailable", async () => {
  assert.equal(typeof Worker, "undefined")
  assert.equal(await wllamaText(MODEL).availability(), "unavailable")
})

test("a failed load left unawaited raises no unhandled rejection; awaited, it rejects", async () => {
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    // wllama can't start on a server (no storage it can use).
    const adapter = wllamaText(MODEL)
    void adapter.create()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    await assert.rejects(adapter.create())
    await adapter.destroySession()
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/wllama/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "wllama-availability-"))
after(() => rm(temporary, { recursive: true, force: true }))

type Control = {
  stored: Array<{ url: string; size: number }>
  gate: Promise<void>
  progressed: null | (() => void)
  /** Storage, network, worker and engine calls, by name. */
  calls: Array<string>
  /** The last download's signal and progress callback. */
  download?: { signal: AbortSignal; progress: (p: { loaded: number; total: number }) => void }
  /** wllama instances ended. */
  exits: number
  /** Memory claims, with their keepLoaded flag, and each load's n_ctx. */
  claims: Array<boolean>
  contexts: Array<number>
  /** Each load's native options. */
  loadOptions: Array<Record<string, unknown>>
  /** Holds wllama's storage listing (getModels) until it resolves. */
  listGate?: Promise<void>
}

/**
 * Builds client.ts against a fake wllama, in a browser-like global scope
 * (a Worker class and OPFS), and runs `body` with it; every storage,
 * network, worker or engine call lands in `control.calls`.
 */
type Built = typeof import("./client.js") & Pick<typeof import("./adapter.js"), "wllamaText">

async function withClient(name: string, body: (client: Built, control: Control, release: () => void) => Promise<void>) {
  const descriptors = Object.fromEntries(
    ["navigator", "Worker", "fetch", "caches", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  )
  let release!: () => void
  const control: Control = {
    stored: [],
    gate: new Promise<void>((resolve) => { release = resolve }),
    progressed: null,
    calls: [],
    exits: 0,
    claims: [],
    contexts: [],
    loadOptions: []
  }
  ;(globalThis as { __wllamaAvailability?: Control }).__wllamaAvailability = control
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const storage = { getDirectory: async () => { control.calls.push("navigator.storage.getDirectory"); return {} } }
  define("navigator", { storage })
  define("Worker", class { constructor() { control.calls.push("new Worker") } })
  define("fetch", async () => { control.calls.push("fetch"); return new Response(null, { headers: { "content-range": "bytes 0-0/1000" } }) })
  define("caches", { open: async () => { control.calls.push("caches.open"); throw new Error("no") } })
  define("indexedDB", { open: () => { control.calls.push("indexedDB.open"); throw new Error("no") } })
  try {
    const outfile = join(temporary, `${name}.mjs`)
    await build({ stdin: { contents: 'export * from "./client.ts"; export { wllamaText } from "./adapter.ts"', resolveDir: join(root, "packages/wllama/src"), loader: "ts" }, outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [{ name: "fake-wllama", setup(bundle) {
      bundle.onResolve({ filter: /@wllama\/wllama\/esm\/index\.js$/ }, () => ({ path: "wllama", namespace: "fake" }))
      bundle.onResolve({ filter: /^\.\/model-memory\.js$/ }, () => ({ path: "memory", namespace: "fake" }))
      bundle.onLoad({ filter: /.*/, namespace: "fake" }, args => ({ contents: args.path === "memory"
        ? "export const claimMemory=async(m)=>{if(m.signal?.aborted)return false;globalThis.__wllamaAvailability.claims.push(m.keepLoaded);return true};export const releaseMemory=()=>{};export const touchMemory=()=>{};"
        : `
        const control=globalThis.__wllamaAvailability;
        export const LoggerWithoutDebug={};
        export class ModelManager { constructor(){control.calls.push("new ModelManager")} async getModels(){ control.calls.push("ModelManager.getModels"); return control.stored } }
        export class Wllama {
          constructor(){control.calls.push("new Wllama");this.modelManager={
            getModels:async()=>{control.calls.push("modelManager.getModels");if(control.listGate)await control.listGate;return control.stored},
            getModelOrDownload:async(source,{progressCallback,signal})=>{
              control.download={signal,progress:progressCallback};
              progressCallback({loaded:250,total:1000});
              control.progressed?.();
              await control.gate;
              progressCallback({loaded:1000,total:1000});
              control.stored.push({url:source.url,size:1000});
              return {size:1000};
            }
          };}
          getWorkerResources(){return {compat:false}}
          async loadModel(_file,options){control.contexts.push(options.n_ctx);control.loadOptions.push(options)}
          getLoadedContextInfo(){return {success:true,n_ctx:0,n_ctx_train:0};}
          async exit(){control.exits++}
        }
      ` }))
    } }] })
    const client = await import(pathToFileURL(outfile).href) as Built
    client.configureRuntime({ gpu: false })
    await body(client, control, release)
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test("availability: downloadable; downloading during the download; available once ready, and from wllama's storage after unloading; downloadable once storage is cleared", { timeout: 5000 }, async () => {
  await withClient("states", async (client, control, release) => {
    assert.equal(await client.availability(MODEL), "downloadable")
    const progress: Array<number> = []
    const progressed = new Promise<void>((resolve) => { control.progressed = resolve })
    const loading = client.loadModel(MODEL, (value: number) => progress.push(value))
    await progressed
    assert.equal(await client.availability(MODEL), "downloading")
    release()
    await loading
    assert.deepEqual(progress, [0.25, 1, 1], "the download's progress, then 1 once ready")
    assert.equal(await client.availability(MODEL), "available")
    await client.unloadModel(MODEL)
    assert.ok(control.stored.some((m) => m.url === modelUrl(MODEL)))
    assert.equal(await client.availability(MODEL), "available", "on the device: its file stays in storage")
    control.stored = control.stored.filter((m) => m.url !== modelUrl(MODEL))
    assert.equal(await client.availability(MODEL), "downloadable", "a cleared storage needs the download again")
  })
})

test("constructing an adapter changes nothing shared; its context and keepLoaded apply when it uses the model, and an adapter without keepLoaded leaves another's", { timeout: 5000 }, async () => {
  await withClient("construct", async (client, control, release) => {
    release()
    const keeper = client.wllamaText(MODEL, { keepLoaded: true, contextLength: 2048 })
    const plain = client.wllamaText(MODEL)
    await plain.create()
    assert.deepEqual([control.claims.at(-1), control.contexts.at(-1)], [false, 0], "constructing the other adapter changed nothing")
    await plain.destroySession()
    await keeper.create()
    assert.deepEqual([control.claims.at(-1), control.contexts.at(-1)], [true, 2048], "using it applies its options")
    await keeper.destroySession()
    const later = client.wllamaText(MODEL)
    await later.create()
    assert.deepEqual([control.claims.at(-1), control.contexts.at(-1)], [true, 0], "a later adapter without keepLoaded leaves it; its own context applies")
    await later.destroySession()
    await client.wllamaText(MODEL, { keepLoaded: false }).create()
    assert.equal(control.claims.at(-1), false, "an explicit false sets it")
  })
})

test("the same progress callback hears 1 on every load call: once for a shared load, then at once on the ready model; a chat's own wait reports nothing more", { timeout: 5000 }, async () => {
  await withClient("same-callback", async (client, control, release) => {
    const heard: Array<number> = []
    const callback = (value: number) => heard.push(value)
    const progressed = new Promise<void>((resolve) => { control.progressed = resolve })
    const first = client.loadModel(MODEL, callback)
    const second = client.loadModel(MODEL, callback)
    await progressed
    release()
    await Promise.all([first, second])
    assert.deepEqual(heard, [0.25, 1, 1], "one load: its progress and its 1, once")
    await client.loadModel(MODEL, callback)
    await client.loadModel(MODEL, callback)
    assert.deepEqual(heard, [0.25, 1, 1, 1, 1], "each call on the ready model hears 1")
    await client.waitForModel(MODEL, undefined, callback)
    assert.deepEqual(heard, [0.25, 1, 1, 1, 1])
  })
})

test("create's signal: aborted before, nothing starts; the only waiter aborting cancels the download; one of two leaving keeps it for the other", { timeout: 5000 }, async () => {
  await withClient("abort", async (client, control) => {
    const { wllamaText } = await import("./adapter.js")
    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      // Aborted before: rejects at once, no wllama started.
      await assert.rejects(client.loadModel(MODEL, undefined, { signal: AbortSignal.abort() }), (error: unknown) => error instanceof DOMException && error.name === "AbortError")
      assert.equal(control.calls.includes("new Wllama"), false)

      // The only waiter aborts mid-download.
      let gate!: () => void
      control.gate = new Promise<void>((resolve) => { gate = resolve })
      const heard: Array<number> = []
      const controller = new AbortController()
      let progressed = new Promise<void>((resolve) => { control.progressed = resolve })
      const alone = client.loadModel(MODEL, (value) => heard.push(value), { signal: controller.signal })
      await progressed
      controller.abort()
      await assert.rejects(alone, { name: "AbortError" })
      assert.equal(control.download?.signal.aborted, true, "the download was cancelled")
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(control.exits, 1, "wllama's worker ended")
      control.download?.progress({ loaded: 900, total: 1000 })
      assert.deepEqual(heard, [0.25], "nothing more after the abort")
      assert.equal(await client.availability(MODEL), "downloadable")
      gate()

      // Two waiters: one leaves, the other still hears progress and completion.
      await new Promise((resolve) => setTimeout(resolve, 0))
      control.stored = []
      control.gate = new Promise<void>((resolve) => { gate = resolve })
      const leaving: Array<number> = []
      const staying: Array<number> = []
      const leave = new AbortController()
      progressed = new Promise<void>((resolve) => { control.progressed = resolve })
      const first = client.loadModel(MODEL, (value) => leaving.push(value), { signal: leave.signal })
      const second = client.loadModel(MODEL, (value) => staying.push(value))
      await progressed
      leave.abort()
      await assert.rejects(first, { name: "AbortError" })
      assert.equal(control.download?.signal.aborted, false, "the download goes on for the other caller")
      gate()
      await second
      assert.deepEqual(leaving, [0.25])
      assert.deepEqual(staying, [0.25, 1, 1])
      assert.equal(await client.availability(MODEL), "available")

      // A chat waiting on the load keeps it going when a session caller aborts.
      await client.unloadModel(MODEL)
      control.gate = new Promise<void>((resolve) => { gate = resolve })
      const session = new AbortController()
      progressed = new Promise<void>((resolve) => { control.progressed = resolve })
      const preload = client.loadModel(MODEL, undefined, { signal: session.signal })
      const chat = client.waitForModel(MODEL)
      await progressed
      session.abort()
      await assert.rejects(preload, { name: "AbortError" })
      assert.equal(control.download?.signal.aborted, false)
      gate()
      await chat

      // Through the adapter (the server-side copy of the client here): an aborted signal rejects, unawaited it raises nothing.
      void wllamaText(MODEL).create({ signal: AbortSignal.abort() })
      await assert.rejects(wllamaText(MODEL).create({ signal: AbortSignal.abort() }), { name: "AbortError" })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

test("a load canceled while wllama lists its storage claims no memory and downloads nothing", { timeout: 5000 }, async () => {
  await withClient("cancel-before-claim", async (client, control, release) => {
    release()
    let list!: () => void
    control.listGate = new Promise<void>((resolve) => { list = resolve })
    const controller = new AbortController()
    const loading = client.loadModel(MODEL, undefined, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await assert.rejects(loading, { name: "AbortError" })
    list()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(control.claims, [], "no memory claimed, so nothing evicted")
    assert.equal(control.download, undefined, "no download started")
  })
})

test("a load with other native options (gpu, threads) loads the model again, with the options as they were when it was asked for", { timeout: 5000 }, async () => {
  await withClient("native-options", async (client, control, release) => {
    release()
    await client.wllamaText(MODEL, { gpu: true, threads: 4 }).create()
    assert.equal(control.loadOptions.at(-1)?.n_threads, 4)
    assert.equal(control.loadOptions.at(-1)?.n_gpu_layers, undefined)
    const cpu = client.wllamaText(MODEL, { gpu: false, threads: 1 })
    await cpu.create()
    assert.equal(control.loadOptions.length, 2, "loaded again for the CPU")
    assert.equal(control.loadOptions.at(-1)?.n_threads, 1)
    assert.equal(control.loadOptions.at(-1)?.n_gpu_layers, 0)
    await cpu.create()
    assert.equal(control.loadOptions.length, 2, "the same options share the load")
    // Options another adapter sets while a load runs don't change it.
    await cpu.destroySession()
    control.stored = []
    let gate!: () => void
    control.gate = new Promise<void>((resolve) => { gate = resolve })
    const progressed = new Promise<void>((resolve) => { control.progressed = resolve })
    const loading = client.wllamaText(MODEL, { threads: 2 }).create()
    await progressed
    client.configureRuntime({ threads: 8 })
    gate()
    await loading
    assert.equal(control.loadOptions.at(-1)?.n_threads, 2)
  })
})

test("claimMemory canceled while another runtime's model unloads stops there and records nothing", async () => {
  const { claimMemory, setMemoryBudget } = await import("./model-memory.js")
  setMemoryBudget(100)
  const held = (globalThis as unknown as Record<symbol, { held: Map<string, unknown> }>)[Symbol.for("@tanstack-ai-browser/model-memory")]!.held
  let finish!: () => void
  const unloading = new Promise<void>((resolve) => { finish = resolve })
  let secondUnloaded = false
  held.set("a", { owner: "a", model: "a", bytes: 60, keepLoaded: false, lastUsed: 0, unload: () => unloading })
  held.set("b", { owner: "b", model: "b", bytes: 30, keepLoaded: false, lastUsed: 1, unload: () => { secondUnloaded = true } })
  try {
    const controller = new AbortController()
    const claiming = claimMemory({ owner: "wllama", model: MODEL, bytes: 90, keepLoaded: false, unload: () => undefined, signal: controller.signal })
    controller.abort()
    finish()
    assert.equal(await claiming, false)
    assert.equal(held.has("wllama"), false, "nothing recorded")
    assert.equal(secondUnloaded, false, "no other model unloaded after the cancel")
    assert.equal(await claimMemory({ owner: "wllama", model: MODEL, bytes: 1, keepLoaded: false, unload: () => undefined, signal: AbortSignal.abort() }), false)
  } finally {
    for (const owner of ["a", "b", "wllama"]) held.delete(owner)
    setMemoryBudget(undefined)
  }
})

test("availability() lists wllama's storage only: no fetch, worker or engine calls", async () => {
  await withClient("no-calls", async (client, control) => {
    assert.equal(await client.availability(MODEL), "downloadable")
    control.stored.push({ url: modelUrl(MODEL), size: 1000 })
    assert.equal(await client.availability(MODEL), "available")
    assert.equal(await client.availability("not/a-model" as typeof MODEL), "unavailable")
    assert.deepEqual([...new Set(control.calls)], ["new ModelManager", "ModelManager.getModels"])
  })
})
