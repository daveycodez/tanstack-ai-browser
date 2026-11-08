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

test("availability: downloadable, downloading with progress, available once ready, and after unloading", { timeout: 5000 }, async () => {
  const descriptors = Object.fromEntries(
    ["navigator", "Worker"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  )
  const originalFetch = globalThis.fetch
  let release!: () => void
  const control = {
    stored: [] as Array<{ url: string; size: number }>,
    gate: new Promise<void>((resolve) => { release = resolve }),
    progressed: null as null | (() => void)
  }
  ;(globalThis as { __wllamaAvailability?: typeof control }).__wllamaAvailability = control
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: { getDirectory: async () => ({}) } } })
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class {} })
  globalThis.fetch = async () => new Response(null, { headers: { "content-range": "bytes 0-0/1000" } })
  try {
    const outfile = join(temporary, "client.mjs")
    await build({ entryPoints: [join(root, "packages/wllama/src/client.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [{ name: "fake-wllama", setup(bundle) {
      bundle.onResolve({ filter: /@wllama\/wllama\/esm\/index\.js$/ }, () => ({ path: "wllama", namespace: "fake" }))
      bundle.onResolve({ filter: /^\.\/model-memory\.js$/ }, () => ({ path: "memory", namespace: "fake" }))
      bundle.onLoad({ filter: /.*/, namespace: "fake" }, args => ({ contents: args.path === "memory"
        ? "export const claimMemory=async()=>{};export const releaseMemory=()=>{};export const touchMemory=()=>{};"
        : `
        const control=globalThis.__wllamaAvailability;
        export const LoggerWithoutDebug={};
        export class ModelManager { async getModels(){ return control.stored } }
        export class Wllama {
          constructor(){this.modelManager={
            getModels:async()=>control.stored,
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
    const client = await import(pathToFileURL(outfile).href)
    client.configureRuntime({ gpu: false })
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
    assert.equal(await client.availability(MODEL), "available", "its file stays in storage")
    control.stored = control.stored.filter((m) => m.url !== modelUrl(MODEL))
    assert.equal(await client.availability(MODEL), "downloadable")
  } finally {
    globalThis.fetch = originalFetch
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
