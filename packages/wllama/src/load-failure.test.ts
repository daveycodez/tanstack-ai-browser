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
const temporary = await mkdtemp(join(tmpdir(), "wllama-load-failure-"))
after(() => rm(temporary, { recursive: true, force: true }))

test("a load llama.cpp reports as failed rejects, frees its worker and memory, and the next load works", { timeout: 5000 }, async () => {
  const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const originalFetch = globalThis.fetch
  const control = { success: false, exits: 0, claims: [] as number[], released: 0 }
  ;(globalThis as { __wllamaLoadFailure?: typeof control }).__wllamaLoadFailure = control
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} })
  globalThis.fetch = async () => new Response(null, { headers: { "content-range": "bytes 0-0/1000" } })
  try {
    const outfile = join(temporary, "client.mjs")
    await build({ entryPoints: [join(root, "packages/wllama/src/client.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [{ name: "public-wllama-runtime", setup(bundle) {
      bundle.onResolve({ filter: /@wllama\/wllama\/esm\/index\.js$/ }, () => ({ path: "wllama", namespace: "contract" }))
      bundle.onResolve({ filter: /^\.\/model-memory\.js$/ }, () => ({ path: "memory", namespace: "contract" }))
      bundle.onLoad({ filter: /.*/, namespace: "contract" }, args => ({ contents: args.path === "memory" ? `
        const control=globalThis.__wllamaLoadFailure;
        export const claimMemory=async(m)=>{control.claims.push(m.bytes)};export const releaseMemory=()=>{control.released++};export const touchMemory=()=>{};` : `
        const control=globalThis.__wllamaLoadFailure;
        export const LoggerWithoutDebug={};
        export class Wllama {
          constructor(){this.modelManager={getModels:async()=>[],getModelOrDownload:async()=>({size:1000})};}
          async loadModel(){}
          getLoadedContextInfo(){return {success:control.success,n_ctx:0,n_ctx_train:0};}
          async exit(){control.exits++}
        }
      ` }))
    } }] })
    const client = await import(pathToFileURL(outfile).href)
    client.configureRuntime({ gpu: false })
    const model = "LiquidAI/LFM3-1.7B-GGUF"
    await assert.rejects(client.loadModel(model), /couldn't load LiquidAI\/LFM3-1\.7B-GGUF/)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(client.modelStatus(model).get().state, "error")
    assert.equal(control.exits, 1, "the failed load's worker is ended")
    assert.equal(control.released, 1, "its memory claim is released")
    control.success = true
    await client.loadModel(model)
    assert.equal(client.modelStatus(model).get().state, "ready", "the failed promise isn't cached")
    assert.ok((control.claims.at(-1) ?? 0) < (control.claims.at(-2) ?? 0), "the claim drops to the loaded estimate")
    await client.unloadModel()
  } finally {
    globalThis.fetch = originalFetch
    if (nativeNavigator) Object.defineProperty(globalThis, "navigator", nativeNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})
