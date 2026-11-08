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
    void adapter.createSessionWithProgress()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
    await assert.rejects(adapter.createSessionWithProgress())
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
}

/**
 * Builds client.ts against a fake wllama, in a browser-like global scope
 * (a Worker class and OPFS), and runs `body` with it; every storage,
 * network, worker or engine call lands in `control.calls`.
 */
async function withClient(name: string, body: (client: typeof import("./client.js"), control: Control, release: () => void) => Promise<void>) {
  const descriptors = Object.fromEntries(
    ["navigator", "Worker", "fetch", "caches", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  )
  let release!: () => void
  const control: Control = {
    stored: [],
    gate: new Promise<void>((resolve) => { release = resolve }),
    progressed: null,
    calls: []
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
    await build({ entryPoints: [join(root, "packages/wllama/src/client.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [{ name: "fake-wllama", setup(bundle) {
      bundle.onResolve({ filter: /@wllama\/wllama\/esm\/index\.js$/ }, () => ({ path: "wllama", namespace: "fake" }))
      bundle.onResolve({ filter: /^\.\/model-memory\.js$/ }, () => ({ path: "memory", namespace: "fake" }))
      bundle.onLoad({ filter: /.*/, namespace: "fake" }, args => ({ contents: args.path === "memory"
        ? "export const claimMemory=async()=>{};export const releaseMemory=()=>{};export const touchMemory=()=>{};"
        : `
        const control=globalThis.__wllamaAvailability;
        export const LoggerWithoutDebug={};
        export class ModelManager { constructor(){control.calls.push("new ModelManager")} async getModels(){ control.calls.push("ModelManager.getModels"); return control.stored } }
        export class Wllama {
          constructor(){control.calls.push("new Wllama");this.modelManager={
            getModels:async()=>{control.calls.push("modelManager.getModels");return control.stored},
            getModelOrDownload:async(source,{progressCallback})=>{
              progressCallback({loaded:250,total:1000});
              control.progressed?.();
              await control.gate;
              progressCallback({loaded:1000,total:1000});
              control.stored.push({url:source.url,size:1000});
              return {size:1000};
            }
          };}
          getWorkerResources(){return {compat:false}}
          async loadModel(){}
          getLoadedContextInfo(){return {success:true,n_ctx:0,n_ctx_train:0};}
          async exit(){}
        }
      ` }))
    } }] })
    const client = await import(pathToFileURL(outfile).href) as typeof import("./client.js")
    client.configureRuntime({ gpu: false })
    await body(client, control, release)
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test("availability: downloadable (also while loading, and with the file stored), available once ready, downloadable after unloading", { timeout: 5000 }, async () => {
  await withClient("states", async (client, control, release) => {
    assert.equal(await client.availability(MODEL), "downloadable")
    const progress: Array<number> = []
    const progressed = new Promise<void>((resolve) => { control.progressed = resolve })
    const loading = client.loadModel(MODEL, (value: number) => progress.push(value))
    await progressed
    assert.equal(await client.availability(MODEL), "downloadable", "a load in progress isn't \"downloading\": progress comes from the callback")
    release()
    await loading
    assert.deepEqual(progress, [0.25, 1, 1], "the download's progress, then 1 once ready")
    assert.equal(await client.availability(MODEL), "available")
    await client.unloadModel(MODEL)
    assert.ok(control.stored.some((m) => m.url === modelUrl(MODEL)))
    assert.equal(await client.availability(MODEL), "downloadable", "its file stays in storage, but it isn't loaded")
  })
})

test("the same progress callback hears 1 on every load call: once for a shared load, then at once on the ready model; a chat's own wait reports nothing more", { timeout: 5000 }, async () => {
  await withClient("same-callback", async (client, control, release) => {
    const heard: Array<number> = []
    const onProgress = (value: number) => heard.push(value)
    const progressed = new Promise<void>((resolve) => { control.progressed = resolve })
    const first = client.loadModel(MODEL, onProgress)
    const second = client.loadModel(MODEL, onProgress)
    await progressed
    release()
    await Promise.all([first, second])
    assert.deepEqual(heard, [0.25, 1, 1], "one load: its progress and its 1, once")
    await client.loadModel(MODEL, onProgress)
    await client.loadModel(MODEL, onProgress)
    assert.deepEqual(heard, [0.25, 1, 1, 1, 1], "each call on the ready model hears 1")
    await client.waitForModel(MODEL, undefined, onProgress)
    assert.deepEqual(heard, [0.25, 1, 1, 1, 1])
  })
})

test("availability() makes no fetch, worker, storage or engine calls", async () => {
  await withClient("no-calls", async (client, control) => {
    control.stored.push({ url: modelUrl(MODEL), size: 1000 })
    assert.equal(await client.availability(MODEL), "downloadable")
    assert.equal(await client.availability("not/a-model" as typeof MODEL), "unavailable")
    assert.deepEqual(control.calls, [])
  })
})
