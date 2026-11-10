/**
 * The client over wllama: availability from its storage, one load per
 * model and settings with the download's progress, a new load for other
 * settings, and unloading. wllama is faked with the API the client uses.
 */
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

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/wllama/package.json"))
const { build } = (await import(pathToFileURL(require.resolve("esbuild")).href)) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "wllama-runtime-"))
after(() => rm(temporary, { recursive: true, force: true }))

type Control = {
  stored: Array<{ url: string; size: number }>
  /** Holds each download until it resolves. */
  gate: Promise<void>
  /** Called once a download has reported progress. */
  progressed: null | (() => void)
  /** Each load: its URL and options. */
  loads: Array<{ url: string; params: Record<string, unknown> }>
  /** wllama instances ended. */
  exits: number
  /** Rejects the next loads with it. */
  loadError?: Error
}

type Built = typeof import("./client.js") & Pick<typeof import("./adapter.js"), "wllamaText">

/** Builds client.ts against a fake wllama, in a scope with a Worker class and OPFS, and runs `body` with it. */
async function withClient(name: string, body: (client: Built, control: Control, release: () => void) => Promise<void>) {
  const descriptors = Object.fromEntries(["navigator", "Worker"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let release!: () => void
  const control: Control = {
    stored: [],
    gate: new Promise<void>((resolve) => (release = resolve)),
    progressed: null,
    loads: [],
    exits: 0
  }
  ;(globalThis as { __wllamaRuntime?: Control }).__wllamaRuntime = control
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  define("navigator", { storage: { getDirectory: async () => ({}) } })
  define("Worker", class {})
  try {
    const outfile = join(temporary, `${name}.mjs`)
    await build({
      stdin: { contents: 'export * from "./client.ts"; export { wllamaText } from "./adapter.ts"', resolveDir: join(root, "packages/wllama/src"), loader: "ts" },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "error",
      plugins: [
        {
          name: "fake-wllama",
          setup(bundle) {
            bundle.onResolve({ filter: /@wllama\/wllama\/esm\/index\.js$/ }, () => ({ path: "wllama", namespace: "fake" }))
            bundle.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
              contents: `
                const control=globalThis.__wllamaRuntime;
                export const LoggerWithoutDebug={};
                export class ModelManager { async getModels(){ return control.stored } }
                export class Wllama {
                  setCompat(){}
                  async loadModelFromUrl(url,params){
                    control.loads.push({url,params});
                    if(control.loadError) throw control.loadError;
                    const stored=control.stored.find((m)=>m.url===url);
                    if(stored){ params.progressCallback({loaded:stored.size,total:stored.size}); return }
                    params.progressCallback({loaded:250,total:1000});
                    control.progressed?.();
                    await Promise.race([control.gate, new Promise((r)=>params.signal.addEventListener("abort",r))]);
                    params.signal.throwIfAborted();
                    params.progressCallback({loaded:1000,total:1000});
                    control.stored.push({url,size:1000});
                  }
                  async exit(){control.exits++}
                }
              `
            }))
          }
        }
      ]
    })
    await body((await import(pathToFileURL(outfile).href)) as Built, control, release)
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test("availability: downloadable, downloading during the download, available once loaded and from storage after unloading", { timeout: 5000 }, async () => {
  await withClient("states", async (client, control, release) => {
    assert.equal(await client.availability(MODEL), "downloadable")
    const progress: Array<number> = []
    const progressed = new Promise<void>((resolve) => (control.progressed = resolve))
    const loading = client.loadModel(MODEL, {}, { onDownloadProgress: (value) => progress.push(value) })
    await progressed
    assert.equal(await client.availability(MODEL), "downloading")
    release()
    await loading
    assert.deepEqual(progress, [0.25, 1], "the download's progress, then 1 once ready")
    assert.equal(await client.availability(MODEL), "available")
    await client.unloadModel(MODEL)
    assert.equal(control.exits, 1)
    assert.equal(await client.availability(MODEL), "available", "its file stays in storage")
    control.stored = []
    assert.equal(await client.availability(MODEL), "downloadable")
  })
})

test("a model in storage loads without download progress: just 1", { timeout: 5000 }, async () => {
  await withClient("stored", async (client, control) => {
    control.stored.push({ url: modelUrl(MODEL), size: 1000 })
    const progress: Array<number> = []
    await client.loadModel(MODEL, {}, { onDownloadProgress: (value) => progress.push(value) })
    assert.deepEqual(progress, [1])
  })
})

test("the adapter loads with its own settings; the same settings share a load, other settings load again", { timeout: 5000 }, async () => {
  await withClient("settings", async (client, control, release) => {
    release()
    await client.wllamaText(MODEL, { contextLength: 2048, gpu: false, threads: 4 }).create()
    assert.equal(control.loads.at(-1)?.url, modelUrl(MODEL))
    assert.equal(control.loads.at(-1)?.params.n_ctx, 2048)
    assert.equal(control.loads.at(-1)?.params.n_gpu_layers, 0)
    assert.equal(control.loads.at(-1)?.params.n_threads, 4)
    await client.wllamaText(MODEL, { contextLength: 2048, gpu: false, threads: 4 }).create()
    assert.equal(control.loads.length, 1, "the same settings: no new load")
    await client.wllamaText(MODEL).create()
    assert.equal(control.loads.length, 2, "other settings load it again")
    assert.equal(control.loads.at(-1)?.params.n_ctx, 0, "the model's training context by default")
    assert.equal(control.exits, 1, "the previous load was freed")
  })
})

test("aborting a wait stops only that caller; unloading stops the download", { timeout: 5000 }, async () => {
  await withClient("abort", async (client, control) => {
    const controller = new AbortController()
    const waiting = client.loadModel(MODEL, {}, { signal: controller.signal })
    controller.abort()
    await assert.rejects(waiting)
    assert.equal(control.loads.length, 1, "the load goes on")
    const again = client.loadModel(MODEL, {})
    await client.unloadModel()
    await assert.rejects(again)
    assert.equal(await client.availability(MODEL), "downloadable")
  })
})

test("a failed load rejects, frees wllama, and the next call loads again", { timeout: 5000 }, async () => {
  await withClient("failure", async (client, control, release) => {
    release()
    control.loadError = new Error("llama.cpp couldn't load it")
    await assert.rejects(client.wllamaText(MODEL).create(), /couldn't load/)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(control.exits, 1)
    control.loadError = undefined
    await client.wllamaText(MODEL).create()
    assert.equal(control.loads.length, 2)
  })
})
