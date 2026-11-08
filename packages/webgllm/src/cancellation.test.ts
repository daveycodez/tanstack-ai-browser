import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/webgllm/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "adapter-cancellation-"))
after(() => rm(temporary, { recursive: true, force: true }))
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"] }
const raw = '{"moveId":"b6-a5"}'
const stats = { inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, promptMs: 1, decodeMs: 1 }
const logger = { request() { return undefined }, provider() { return undefined }, errors() { return undefined } }
type TestOptions = { chatOptions: { model: string; logger: object; threadId: string; messages: Array<{role:string;content:string}>; abortController?: AbortController; request?: Request | RequestInit }; outputSchema: object }
type TestAdapter = { model: string; structuredOutput(options: TestOptions): Promise<{data:unknown}>; structuredOutputStream?(options: TestOptions): AsyncIterable<unknown> }
type AdapterPackage = { webgllmText(model?:string):TestAdapter; chat(options:Record<string,unknown>):Promise<unknown> }

let init = async () => undefined
let generate = async () => raw
let measurements = async () => 1
const state = { inits: 0, generations: 0, discards: 0, returned: 0, initializationSignal: undefined as AbortSignal | undefined, signal: undefined as AbortSignal | undefined, measurementSignal: undefined as AbortSignal | undefined,
  async initialize(signal?: AbortSignal) { this.inits++; this.initializationSignal = signal; await init() },
  async generate(signal?: AbortSignal) { this.generations++; this.signal = signal; return generate() },
  async measure(signal?: AbortSignal) { this.measurementSignal = signal; return measurements() }, raw, stats }
;(globalThis as { __cancellationContract?: typeof state }).__cancellationContract = state
let loaded: Promise<AdapterPackage> | undefined
function adapterPackage(): Promise<AdapterPackage> {
  loaded ??= (async () => {
    const outfile = join(temporary, "webgllm.mjs")
    await build({ stdin: { contents: "export * from './src/adapter.ts';export {chat} from '@tanstack/ai';", resolveDir: join(root, "packages/webgllm"), loader: "ts" }, outfile, bundle: true, format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error", plugins: [{ name: "controlled-runtime", setup(bundle) {
      bundle.onResolve({ filter: /^\.\/models\.js$/ }, args => args.importer.endsWith(`/webgllm/src/adapter.ts`) ? { path: "webgllm", namespace: "controlled" } : undefined)
      bundle.onLoad({ filter: /.*/, namespace: "controlled" }, () => ({ contents: `
        const c=globalThis.__cancellationContract;
        export const setKeepLoaded=()=>{};
        export const availability=async()=>"available";export const loadModel=async()=>{};export const unloadModel=async()=>{};export const ensureModel=async(model,contextLength,signal)=>{signal?.throwIfAborted();await c.initialize(signal);signal?.throwIfAborted()};
        export const touchModel=()=>{};
        export const webgllm={chat:{completions:{create:async(body,options)=>(async function*(){try{const content=await c.generate(options?.signal);
          yield {choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]};
          yield {choices:[{index:0,delta:{},finish_reason:'stop'}]};
          yield {choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:0}},timings:{first_token_ms:1,prompt_ms:1,decode_ms:1,prompt_tokens_per_second:1,decode_tokens_per_second:1}}
        }finally{c.returned++}})()}}};
      ` }))
    } }] })
    return import(pathToFileURL(outfile).href)
  })()
  return loaded
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function reset() { state.inits = state.generations = state.discards = state.returned = 0; state.signal = state.initializationSignal = state.measurementSignal = undefined; init = async () => undefined; generate = async () => raw; measurements = async () => 1 }
function options(adapter: {model:string}, cancellation: object) { return { chatOptions: { model: adapter.model, logger, threadId: "cancel-contract", messages: [{ role: "user", content: "Choose a move" }], ...cancellation }, outputSchema: schema } }
async function adapterFor(): Promise<TestAdapter> { return (await adapterPackage()).webgllmText("LiquidAI/LFM3-1.7B-GGUF") }
test("webgllm: structured cancellation via request.signal and legacy controller", { timeout: 10_000 }, async () => {
  {
    const adapter = await adapterFor()
    for (const mode of ["request", "controller"] as const) {
      const transport = (controller: AbortController) => mode === "request" ? { request: new Request("http://localhost", { signal: controller.signal }) } : { abortController: controller }
      reset(); const success = new AbortController(); const request = transport(success)
      const result = await adapter.structuredOutput(options(adapter, request))
      const signal = "request" in request ? request.request?.signal : success.signal
      assert.deepEqual(result.data, {moveId:"b6-a5"}); assert.equal(state.signal, signal)
      reset(); const before = new AbortController(); const reason = new Error("cancel before initialization"); before.abort(reason)
      await assert.rejects(adapter.structuredOutput(options(adapter, transport(before))), error => error === reason)
      assert.equal(state.inits, 0); assert.equal(state.generations, 0)
      reset(); const starting = new AbortController(); const initializing = gate(); const ready = gate()
      init = async () => { initializing.release(); await ready.promise }
      const initializingResult = adapter.structuredOutput(options(adapter, transport(starting)))
      const initializationRejected = assert.rejects(initializingResult, error => error === reason)
      await initializing.promise; starting.abort(reason); ready.release(); await initializationRejected
      assert.equal(state.generations, 0, "cancellation during initialization prevents generation")
      reset(); const during = new AbortController(); const entered = gate(); const resume = gate()
      generate = async () => { entered.release(); await resume.promise; return raw }
      const pending = adapter.structuredOutput(options(adapter, transport(during))); const rejected = assert.rejects(pending, error => error === reason)
      await entered.promise; during.abort(reason); resume.release(); await rejected
      assert.equal(state.returned, 1)
      reset(); const nativeAbort = new AbortController(); const nativeEntered = gate()
      generate = () => new Promise<string>((_resolve, reject) => {
        nativeEntered.release()
        state.signal?.addEventListener("abort", () => reject(new DOMException("backend aborted", "AbortError")), {once:true})
      })
      const nativeResult = adapter.structuredOutput(options(adapter, transport(nativeAbort)))
      const nativeRejected = assert.rejects(nativeResult, error => error instanceof DOMException && error.name === "AbortError")
      await nativeEntered.promise; nativeAbort.abort(); await nativeRejected
    }
    reset(); const preferred = new AbortController(); const fallback = new AbortController(); fallback.abort()
    await adapter.structuredOutput(options(adapter, { abortController: preferred, request: {signal:fallback.signal} }))
    assert.equal(state.signal, preferred.signal, "legacy controller retains streaming-path precedence")
  }
})

test("installed TanStack chat forwards abortController through structured chatOptions.request.signal", async () => {
  reset(); const p = await adapterPackage(); const adapter = await adapterFor(); const controller = new AbortController()
  let seen = false
  const check = (request: TestOptions) => { seen = true; assert.ok(request.chatOptions.request); assert.equal(request.chatOptions.abortController, undefined); assert.equal((request.chatOptions.request as Request).signal, controller.signal) }
  // chat() uses structuredOutputStream when the adapter has it (stream: false drains it), else structuredOutput.
  if (adapter.structuredOutputStream) {
    const original = adapter.structuredOutputStream.bind(adapter)
    adapter.structuredOutputStream = request => { check(request); return original(request) }
  } else {
    const original = adapter.structuredOutput.bind(adapter)
    adapter.structuredOutput = request => { check(request); return original(request) }
  }
  await p.chat({ adapter, threadId:"forwarding-contract", messages:[{role:"user",content:"Choose a move"}], outputSchema:schema, abortController:controller, stream:false })
  assert.equal(seen,true);assert.equal(state.signal,controller.signal)
})
