import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/wllama/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "wllama-cancel-contract-"))
after(() => rm(temporary, { recursive: true, force: true }))

test("Wllama caller aborts stop both loading waits, while the shared background load completes", { timeout: 5000 }, async () => {
  const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const originalFetch = globalThis.fetch
  let release!: (value: unknown[]) => void
  const control = { instances: 0, calls: [] as Array<Record<string, unknown>>, signal: undefined as AbortSignal | undefined, loading: new Promise<unknown[]>(resolveLoad => { release = resolveLoad }) }
  ;(globalThis as { __wllamaCancel?: typeof control }).__wllamaCancel = control
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Firefox/145" } })
  globalThis.fetch = async () => new Response(null, { headers: { "content-length": "0" } })
  try {
    const outfile = join(temporary, "client.mjs")
    await build({ entryPoints: [join(root, "packages/wllama/src/client.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [{ name: "public-wllama-runtime", setup(bundle) {
      bundle.onResolve({ filter: /@wllama\/wllama\/esm\/index\.js$/ }, () => ({ path: "vendor", namespace: "contract" }))
      bundle.onResolve({ filter: /^\.\/model-memory\.js$/ }, () => ({ path: "memory", namespace: "contract" }))
      bundle.onLoad({ filter: /.*/, namespace: "contract" }, args => ({ contents: args.path === "memory" ? 'export const claimMemory=async()=>{};export const releaseMemory=()=>{};export const touchMemory=()=>{};' : `
        const control=globalThis.__wllamaCancel;
        export const LoggerWithoutDebug={};
        export class Wllama {
          constructor(){control.instances++;this.modelManager={getModels:()=>control.loading,getModelOrDownload:async(_source,options)=>{control.signal=options.signal;return {size:0};}};}
          async loadModel(){}
          getLoadedContextInfo(){return {success:true};}
          async exit(){}
          async createChatCompletion(options){control.calls.push(options);return options.stream?(async function*(){yield {choices:[]}})():{choices:[{message:{content:'{}'},finish_reason:'stop'}]};}
        }
      ` }))
    } }] })
    const client = await import(pathToFileURL(outfile).href)
    client.configureRuntime({ wasmUrl: "test.wasm", gpu: false })
    const model = "unsloth/Qwen3.5-2B-GGUF"
    const request = { messages: [{ role: "user", content: "hi" }] }
    const already = new AbortController(); already.abort(new Error("already cancelled"))
    await assert.rejects(client.completeChat(model, request, already.signal), /already cancelled/)
    await assert.rejects(client.streamChat(model, request, already.signal), /already cancelled/)
    assert.equal(control.instances, 0, "pre-aborted requests never start a download")
    const a = new AbortController(), b = new AbortController()
    const complete = client.completeChat(model, request, a.signal)
    const streaming = client.streamChat(model, request, b.signal)
    a.abort(new Error("cancel complete")); b.abort(new Error("cancel stream"))
    await assert.rejects(complete, /cancel complete/)
    await assert.rejects(streaming, /cancel stream/)
    assert.equal(control.instances, 1, "callers share one model download")
    assert.equal(control.calls.length, 0, "cancelled calls never reach inference")
    release([])
    await client.loadModel(model)
    assert.ok(control.signal)
    assert.equal(control.signal.aborted, false, "caller cancellation does not cancel the cache-filling download")
    const next = new AbortController()
    await client.completeChat(model, request, next.signal)
    const chunks = await client.streamChat(model, request, next.signal)
    for await (const chunk of chunks) assert.ok(chunk)
    assert.equal(control.calls.length, 2)
    assert.ok(control.calls.every(call => call.abortSignal === next.signal))
    await client.unloadModel()
  } finally {
    globalThis.fetch = originalFetch
    if (nativeNavigator) Object.defineProperty(globalThis, "navigator", nativeNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})
