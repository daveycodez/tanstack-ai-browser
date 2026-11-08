import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/prompt-api/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "adapter-cancellation-"))
after(() => rm(temporary, { recursive: true, force: true }))
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"] }
const raw = '{"moveId":"b6-a5"}'
const stats = { inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, promptMs: 1, decodeMs: 1 }
const logger = { request() { return undefined }, provider() { return undefined }, errors() { return undefined } }
type TestOptions = { chatOptions: { model: string; logger: object; threadId: string; messages: Array<{role:string;content:string}>; abortController?: AbortController; request?: Request | RequestInit }; outputSchema: object }
type TestAdapter = { model: string; structuredOutput(options: TestOptions): Promise<{data:unknown}>; structuredOutputStream?(options: TestOptions): AsyncIterable<unknown> }
type AdapterPackage = { promptApiText(model?:string):TestAdapter; chat(options:Record<string,unknown>):Promise<unknown> }

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
    const outfile = join(temporary, "prompt-api.mjs")
    await build({ stdin: { contents: "export * from './src/adapter.ts';export {chat} from '@tanstack/ai';", resolveDir: join(root, "packages/prompt-api"), loader: "ts" }, outfile, bundle: true, format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error", plugins: [{ name: "controlled-runtime", setup(bundle) {
      bundle.onResolve({ filter: /^\.\/sessions\.js$/ }, args => args.importer.endsWith(`/prompt-api/src/adapter.ts`) ? { path: "prompt-api", namespace: "controlled" } : undefined)
      bundle.onLoad({ filter: /.*/, namespace: "controlled" }, () => ({ contents: `
        const c=globalThis.__cancellationContract;
        export const leaseSession=async(options)=>{await c.initialize(options.signal);return {cachedTokens:0,overflowed:()=>false,discard(){c.discards++},session:{contextUsage:20,contextWindow:8192,measureContextUsage:(input,options)=>c.measure(options?.signal),prompt:(input,options)=>c.generate(options.signal)}}};
      ` }))
    } }] })
    return import(pathToFileURL(outfile).href)
  })()
  return loaded
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function reset() { state.inits = state.generations = state.discards = state.returned = 0; state.signal = state.initializationSignal = state.measurementSignal = undefined; init = async () => undefined; generate = async () => raw; measurements = async () => 1 }
function options(adapter: {model:string}, cancellation: object) { return { chatOptions: { model: adapter.model, logger, threadId: "cancel-contract", messages: [{ role: "user", content: "Choose a move" }], ...cancellation }, outputSchema: schema } }
async function adapterFor(): Promise<TestAdapter> { return (await adapterPackage()).promptApiText("built-in") }
test("prompt-api: structured cancellation via request.signal and legacy controller", { timeout: 10_000 }, async () => {
  {
    const adapter = await adapterFor()
    for (const mode of ["request", "controller"] as const) {
      const transport = (controller: AbortController) => mode === "request" ? { request: new Request("http://localhost", { signal: controller.signal }) } : { abortController: controller }
      reset(); const success = new AbortController(); const request = transport(success)
      const result = await adapter.structuredOutput(options(adapter, request))
      const signal = "request" in request ? request.request?.signal : success.signal
      assert.deepEqual(result.data, {moveId:"b6-a5"}); assert.equal(state.signal, signal)
      assert.equal(state.initializationSignal, signal)
      assert.equal(state.measurementSignal, signal)
      reset(); const before = new AbortController(); const reason = new Error("cancel before initialization"); before.abort(reason)
      await assert.rejects(adapter.structuredOutput(options(adapter, transport(before))), error => error === reason)
      assert.equal(state.inits, 0); assert.equal(state.generations, 0)
      reset(); const starting = new AbortController(); const initializing = gate(); const ready = gate()
      init = async () => { initializing.release(); await ready.promise }
      const initializingResult = adapter.structuredOutput(options(adapter, transport(starting)))
      const initializationRejected = assert.rejects(initializingResult, error => error === reason)
      await initializing.promise; starting.abort(reason); ready.release(); await initializationRejected
      assert.equal(state.generations, 0, "cancellation during initialization prevents generation")
      assert.equal(state.discards, 1, "a late initialization still releases its ephemeral session")
      reset(); const during = new AbortController(); const entered = gate(); const resume = gate()
      generate = async () => { entered.release(); await resume.promise; return raw }
      const pending = adapter.structuredOutput(options(adapter, transport(during))); const rejected = assert.rejects(pending, error => error === reason)
      await entered.promise; during.abort(reason); resume.release(); await rejected
      assert.equal(state.discards, 1)
      reset(); const nativeAbort = new AbortController(); const nativeEntered = gate()
      generate = () => new Promise<string>((_resolve, reject) => {
        nativeEntered.release()
        state.signal?.addEventListener("abort", () => reject(new DOMException("backend aborted", "AbortError")), {once:true})
      })
      const nativeResult = adapter.structuredOutput(options(adapter, transport(nativeAbort)))
      const nativeRejected = assert.rejects(nativeResult, error => error === nativeAbort.signal.reason)
      await nativeEntered.promise; nativeAbort.abort(); await nativeRejected
    }
    reset(); const preferred = new AbortController(); const fallback = new AbortController(); fallback.abort()
    await adapter.structuredOutput(options(adapter, { abortController: preferred, request: {signal:fallback.signal} }))
    assert.equal(state.signal, preferred.signal, "legacy controller retains streaming-path precedence")
  }
})

test("Prompt API cancellation during usage measurement cannot publish a late answer", async () => {
  reset(); const adapter = await adapterFor(); const controller = new AbortController(); const entered = gate(); const release = gate(); const reason = new Error("cancel measurement")
  measurements = async () => { entered.release(); await release.promise; return 1 }
  const result = adapter.structuredOutput(options(adapter, {request:{signal:controller.signal}}))
  const rejected = assert.rejects(result, error => error === reason)
  await entered.promise; assert.equal(state.measurementSignal,controller.signal); controller.abort(reason); release.release(); await rejected; assert.equal(state.discards,1)
})

test("Prompt API initialization checks aborts across availability and late session creation", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "LanguageModel")
  const outfile = join(temporary, "prompt-model.mjs")
  await build({ entryPoints:[join(root,"packages/prompt-api/src/model.ts")], outfile, bundle:true, format:"esm", platform:"node", logLevel:"error" })
  const {createLanguageModel} = await import(pathToFileURL(outfile).href)
  let creates=0;let destroyed=0
  const entered=gate();const available=gate();const controller=new AbortController();const reason=new Error("cancel availability")
  Object.defineProperty(globalThis,"LanguageModel",{configurable:true,value:{availability:async()=>{entered.release();await available.promise;return "available"},create:async()=>{creates++;return{contextWindow:8192,destroy(){destroyed++}}}}})
  try {
    const pending=createLanguageModel({},controller.signal);const rejected=assert.rejects(pending,error=>error===reason)
    await entered.promise;controller.abort(reason);available.release();await rejected;assert.equal(creates,0)
    const creation=gate();const ready=gate();const second=new AbortController()
    Object.defineProperty(globalThis,"LanguageModel",{configurable:true,value:{availability:async()=>"available",create:async()=>{creates++;creation.release();await ready.promise;return{contextWindow:8192,destroy(){destroyed++}}}}})
    const late=createLanguageModel({},second.signal);const lateRejected=assert.rejects(late,error=>error===reason)
    await creation.promise;second.abort(reason);ready.release();await lateRejected;assert.equal(destroyed,1,"discard a newly created session returned after cancellation")
  } finally {if(original)Object.defineProperty(globalThis,"LanguageModel",original);else Reflect.deleteProperty(globalThis,"LanguageModel")}
})
