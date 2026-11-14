/**
 * What the adapter adds to TanStack's Chat Completions adapter: WebLLM's
 * option names, its JSON Schema shape, the caller's signal reaching the
 * engine's interrupt, loading with progress, availability and unloading.
 * WebLLM is stubbed.
 */
import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/web-llm/package.json"))
const { build } = (await import(pathToFileURL(require.resolve("esbuild")).href)) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "web-llm-wrapper-"))
after(() => rm(temporary, { recursive: true, force: true }))

type Request = Record<string, unknown>
/** What the stubbed WebLLM receives, and what it answers. */
const control = {
  requests: [] as Array<Request>,
  reloads: [] as Array<{ model: string; chatOptions: unknown }>,
  unloads: 0,
  interrupts: 0,
  /** Requests that got the engine's lock and began generating (WebLLM's prefill). */
  prefills: [] as Array<Request>,
  cached: new Set<string>(),
  /** Progress values each reload reports. */
  progress: [] as Array<number>,
  /** Each reload waits for this. */
  reloadGate: Promise.resolve() as Promise<void>,
  chunks: [] as Array<unknown>,
  /** A streaming reply waits for this after its chunks (an interrupt resolves it). */
  hold: null as Promise<void> | null,
  release: () => undefined as void,
  /** An embeddings.create waits for this. */
  embedHold: null as Promise<void> | null,
  /** The worker each engine was made with, and the log levels set. */
  workers: [] as Array<unknown>,
  logLevels: [] as Array<string>
}
;(globalThis as { __webLlm?: typeof control }).__webLlm = control
/** A stand-in worker: it can fail, as a real one whose script doesn't load or throws. */
class FakeWorker {
  static started: Array<FakeWorker> = []
  listeners = new Map<string, Set<(event: unknown) => void>>()
  terminated = false
  constructor(mine = false) {
    if (!mine) FakeWorker.started.push(this)
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string, event: unknown = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
  terminate() {
    this.terminated = true
  }
}
;(globalThis as { Worker?: unknown }).Worker = class extends FakeWorker {
  constructor() {
    super()
  }
}

const outfile = join(temporary, "web-llm-adapter.mjs")
await build({
  entryPoints: [join(root, "packages/web-llm/src/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  conditions: ["@tanstack-ai-browser/source"],
  logLevel: "error",
  plugins: [
    {
      name: "stub-web-llm",
      setup(bundle) {
        bundle.onResolve({ filter: /^@mlc-ai\/web-llm$/ }, () => ({ path: "web-llm", namespace: "stub" }))
        bundle.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `
            const control=globalThis.__webLlm;
            export const hasModelInCache=async(model)=>control.cached.has(model);
            export const ModelType={LLM:0,embedding:1,VLM:2};
            export class WebWorkerMLCEngineHandler{}
            export const prebuiltAppConfig={model_list:[{model_id:"Qwen3-1.7B-q4f16_1-MLC"},{model_id:"Qwen2.5-0.5B-Instruct-q4f16_1-MLC"},{model_id:"Phi-3.5-vision-instruct-q4f16_1-MLC",model_type:2},{model_id:"snowflake-arctic-embed-s-q0f32-MLC-b4",model_type:1}]};
            // Like WebLLM: the worker keeps the last catalog it was given
            // (the prebuilt one at first), reload looks the model up in it,
            // generations wait for the model's lock, and the interrupt is
            // the engine's, ending whichever generation runs.
            export class WebWorkerMLCEngine{
              constructor(worker,config){
                control.workers.push(worker);
                this.report=config.initProgressCallback;
                this.appConfig=prebuiltAppConfig;
                this.lock=Promise.resolve();
                const engine=this;
                this.chat={completions:{create:async(request)=>{
                  control.requests.push(request);
                  if(request.stream) return (async function*(){
                    const before=engine.lock;let release;engine.lock=new Promise((r)=>(release=r));
                    await before;
                    try{control.prefills.push(request);yield* control.chunks;if(control.hold) await control.hold}finally{release()}
                  })();
                  return {choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:'{"city":"Oslo"}'}}]};
                }}};
                this.embeddings={create:async(request)=>{
                  control.requests.push(request);
                  if(control.embedHold) await control.embedHold;
                  return {data:request.input.map((_,index)=>({index,embedding:[index,1]})),usage:{prompt_tokens:3,total_tokens:3}};
                }};
              }
              setAppConfig(appConfig){this.appConfig=appConfig}
              setLogLevel(level){control.logLevels.push(level)}
              async reload(model,chatOptions){
                if(!this.appConfig.model_list.some((record)=>record.model_id===model)) throw new Error("Cannot find model record in appConfig for "+model);
                control.reloads.push({model,chatOptions});
                for(const progress of control.progress) this.report({progress,timeElapsed:0,text:""});
                await control.reloadGate;
              }
              async unload(){control.unloads++}
              interruptGenerate(){control.interrupts++;control.release()}
            }
          `
        }))
      }
    }
  ]
})

type Chunk = { type: string; [key: string]: unknown }
type Adapter = {
  model: string
  chatStream(options: Record<string, unknown>): AsyncIterable<Chunk>
  structuredOutput(options: Record<string, unknown>): Promise<{ data: unknown }>
  availability(): Promise<string>
  create(options?: { onDownloadProgress?: (progress: number) => void }): Promise<unknown>
  destroy(): Promise<void>
}
type EmbeddingAdapter = Pick<Adapter, "create" | "destroy"> & { model: string; createEmbeddings(options: Record<string, unknown>): Promise<{ embeddings: Array<{ vector: Array<number>; index: number }> }> }
type Module = {
  webLlmText: (model: string, config?: Record<string, unknown>) => Adapter & { inputModalities: ReadonlyArray<string> }
  webLlmEmbedding: (model?: string, config?: Record<string, unknown>) => EmbeddingAdapter
}
/** A fresh copy of the adapter's module: its own engine, loaded model and WebGPU check. */
let copies = 0
const fresh = async () => (await import(`${pathToFileURL(outfile).href}?${++copies}`)) as Module

const setGpu = (gpu: unknown) => Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true })
setGpu({ requestAdapter: async () => ({}) })

const { webLlmText, webLlmEmbedding } = await fresh()
const MODEL = "Qwen3-1.7B-q4f16_1-MLC"
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const options = (extra: Record<string, unknown> = {}) => ({
  logger,
  model: MODEL,
  threadId: "wrapper",
  messages: [{ role: "user", content: "hi" }],
  ...extra
})
const delta = (d: object, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta: d, finish_reason: finish }] })

async function run(adapter: Adapter, extra: Record<string, unknown> = {}) {
  const events: Array<Chunk> = []
  for await (const event of adapter.chatStream(options(extra))) events.push(event)
  return { events, request: control.requests.at(-1)! }
}

beforeEach(() => {
  control.requests = []
  control.reloads = []
  control.unloads = 0
  control.interrupts = 0
  control.prefills = []
  control.cached = new Set()
  control.progress = []
  control.reloadGate = Promise.resolve()
  control.chunks = [delta({ role: "assistant", content: "Hi" }), delta({}, "stop")]
  control.hold = null
  control.embedHold = null
  control.workers = []
  control.logLevels = []
})

test("modelOptions go to WebLLM as given", async () => {
  const given = { max_tokens: 64, temperature: 0.2, top_p: 0.9, frequency_penalty: 0.1, presence_penalty: 0.5, repetition_penalty: 1.1, seed: 7, stop: ["END"], logit_bias: { "42": -100 } }
  const { request, events } = await run(webLlmText(MODEL), { modelOptions: given })
  for (const [key, value] of Object.entries(given)) assert.deepEqual(request[key], value, key)
  assert.equal(request.model, MODEL)
  assert.equal(events.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta, "Hi")
  // Left out: WebLLM's own (the model's config).
  const plain = (await run(webLlmText(MODEL))).request
  assert.equal(plain.temperature, undefined)
  assert.equal(plain.response_format, undefined)
})

test("structured output sends the schema as given, in WebLLM's json_object shape", async () => {
  const schema = { type: "object", properties: { city: { type: "string" }, note: { type: "string" } }, required: ["city"] }
  const result = await webLlmText(MODEL).structuredOutput({ chatOptions: options(), outputSchema: schema })
  assert.deepEqual(result.data, { city: "Oslo" })
  const format = control.requests.at(-1)!.response_format as { type: string; schema: string }
  assert.equal(format.type, "json_object")
  assert.deepEqual(JSON.parse(format.schema), schema)
})

test("the caller's signal reaches the engine's interrupt, until the reply ends", async () => {
  control.hold = new Promise((resolve) => (control.release = resolve))
  control.chunks = [delta({ role: "assistant", content: "Hi" })]
  const controller = new AbortController()
  const stream = webLlmText(MODEL).chatStream(options({ request: { signal: controller.signal } }))
  for await (const event of stream) {
    if (event.type === "TEXT_MESSAGE_CONTENT") controller.abort()
  }
  assert.equal(control.interrupts, 1)
  // A finished reply's signal no longer interrupts the engine.
  control.hold = null
  const later = new AbortController()
  await run(webLlmText(MODEL), { request: { signal: later.signal } })
  later.abort()
  assert.equal(control.interrupts, 1)
})

test("create loads with the context length, reporting the download only, then 1; destroy unloads", async () => {
  const { webLlmText } = await fresh()
  // WebLLM reports the download, then loading from its cache from 0 again.
  control.progress = [0, 0.5, 1, 0, 0.7]
  const heard: Array<number> = []
  const own: Array<number> = []
  const adapter = webLlmText(MODEL, { contextLength: 2048, onDownloadProgress: (p: number) => own.push(p) })
  await adapter.create({ onDownloadProgress: (p) => heard.push(p) })
  assert.deepEqual(heard, [0, 0.5, 1])
  assert.deepEqual(own, [0, 0.5, 1])
  assert.deepEqual(control.reloads, [{ model: MODEL, chatOptions: { context_window_size: 2048 } }])
  // Loaded with these settings: no reload. Other settings: a reload.
  await adapter.create()
  assert.equal(control.reloads.length, 1)
  await webLlmText(MODEL).create()
  assert.equal(control.reloads.length, 2)
  await webLlmText(MODEL).destroy()
  assert.equal(control.unloads, 1)

  // A stored model: no download progress, only 1.
  control.cached.add(MODEL)
  const stored: Array<number> = []
  await webLlmText(MODEL, { contextLength: 1024 }).create({ onDownloadProgress: (p) => stored.push(p) })
  assert.deepEqual(stored, [1])
})

test("availability: unavailable without WebGPU, else downloading, available or downloadable", async () => {
  setGpu(undefined)
  assert.equal(await (await fresh()).webLlmText(MODEL).availability(), "unavailable")
  setGpu({ requestAdapter: async () => null })
  assert.equal(await (await fresh()).webLlmText(MODEL).availability(), "unavailable")
  setGpu({ requestAdapter: async () => ({}) })

  const { webLlmText } = await fresh()
  const adapter = webLlmText(MODEL)
  assert.equal(await adapter.availability(), "downloadable")
  let open = () => undefined as void
  control.reloadGate = new Promise((resolve) => (open = resolve))
  const loading = adapter.create()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(await adapter.availability(), "downloading")
  open()
  await loading
  assert.equal(await adapter.availability(), "available")
  control.cached.add("SmolLM2-135M-Instruct-q0f16-MLC")
  assert.equal(await webLlmText("SmolLM2-135M-Instruct-q0f16-MLC").availability(), "available")
})

test("tools by prompt: none sent to WebLLM, listed in the system prompt; a fenced call becomes TOOL_CALL events and stops the generation", async () => {
  const tools = [{ name: "get_weather", description: "Weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }]
  control.chunks = [
    delta({ role: "assistant", content: "Checking. " }),
    delta({ content: '```tool_call\n{"name": "get_weather", "arguments": {"city": "Oslo"}}\n```' }),
    delta({ content: " ignored" }),
    delta({}, "stop")
  ]
  const { events, request } = await run(webLlmText(MODEL), {
    tools,
    systemPrompts: ["Be brief."],
    messages: [
      { role: "user", content: "Weather in Paris?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", toolCallId: "c1", content: '{"temp":3}' },
      { role: "user", content: "And Oslo?" }
    ]
  })
  assert.equal(request.tools, undefined)
  const messages = request.messages as Array<{ role: string; content: string }>
  assert.ok(messages.every((m) => m.role !== "tool"), "results go back as text")
  assert.match(messages[0]!.content, /^Be brief\.[\s\S]*get_weather[\s\S]*tool_call/)
  assert.match(messages[2]!.content, /```tool_call\n\{"name":"get_weather","arguments":\{"city":"Paris"\},"id":"c1"\}/)
  assert.match(messages[3]!.content, /```tool_result\n\{"name":"get_weather","result":\{"temp":3\}/)
  const end = events.find((e) => e.type === "TOOL_CALL_END")
  assert.equal(end?.toolCallName ?? end?.toolName, "get_weather")
  assert.equal((events.at(-1) as Chunk).finishReason, "tool_calls")
  const text = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("")
  assert.equal(text, "Checking. ")
  assert.equal(control.interrupts, 1)
})

test("thinking between <think> tags comes back as REASONING events, the rest as text", async () => {
  control.chunks = [delta({ role: "assistant", content: "<think>" }), delta({ content: "Let me check." }), delta({ content: "</think>\n\nHi!" }), delta({}, "stop")]
  const { events } = await run(webLlmText(MODEL))
  const reasoning = events.filter((e) => e.type === "REASONING_MESSAGE_CONTENT").map((e) => e.delta).join("")
  const text = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("")
  assert.equal(reasoning, "Let me check.")
  assert.equal(text, "\n\nHi!")
})

test("reasoning turns thinking on or off with WebLLM's enable_thinking, for models with the switch", async () => {
  const off = (await run(webLlmText(MODEL), { reasoning: { level: "off" } })).request
  assert.deepEqual(off.extra_body, { enable_thinking: false })
  assert.equal(off.reasoning_effort, undefined)
  const on = (await run(webLlmText(MODEL), { reasoning: { level: "high" }, modelOptions: { extra_body: { enable_latency_breakdown: true } } })).request
  assert.deepEqual(on.extra_body, { enable_latency_breakdown: true, enable_thinking: true })
  // Not asked: the model thinks as it would.
  assert.equal((await run(webLlmText(MODEL))).request.extra_body, undefined)
  // A model without the switch gets none.
  const plain = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC"
  assert.equal((await run(webLlmText(plain), { model: plain, reasoning: { level: "off" } })).request.extra_body, undefined)
})

test("images go to WebLLM as image_url without detail; vision models read images", async () => {
  const VISION = "Phi-3.5-vision-instruct-q4f16_1-MLC"
  const adapter = webLlmText(VISION)
  assert.deepEqual(adapter.inputModalities, ["text", "image"])
  assert.deepEqual(webLlmText(MODEL).inputModalities, ["text"])
  const image = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }
  const { request } = await run(adapter, { model: VISION, messages: [{ role: "user", content: [{ type: "text", content: "What's this?" }, image] }] })
  const content = (request.messages as Array<{ content: unknown }>).at(-1)!.content
  assert.deepEqual(content, [{ type: "text", text: "What's this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }])
})

test("embeddings: WebLLM's embeddings.create, a vector per input, in their own engine", async () => {
  const adapter = webLlmEmbedding()
  assert.equal(adapter.model, "snowflake-arctic-embed-s-q0f32-MLC-b4")
  const result = await adapter.createEmbeddings({ logger, model: adapter.model, input: ["a", "b"] })
  assert.deepEqual(result.embeddings, [{ vector: [0, 1], index: 0 }, { vector: [1, 1], index: 1 }])
  assert.deepEqual(control.requests.at(-1), { model: adapter.model, input: ["a", "b"] })
  assert.equal(control.reloads.at(-1)!.model, adapter.model)
})

test("a tool call's JSON is read whole: call syntax inside its string arguments is text", async () => {
  const tools = [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } } }]
  for (const query of ["call:bogus{arg:value}", "[bogus(arg=1)]", "<tool_call>bogus</tool_call>"]) {
    const call = JSON.stringify({ name: "search", arguments: { query } })
    control.chunks = [delta({ role: "assistant", content: "```tool_call\n" + call + "\n```" }), delta({}, "stop")]
    const { events } = await run(webLlmText(MODEL), { tools })
    const end = events.find((e) => e.type === "TOOL_CALL_END")
    assert.equal(end?.toolCallName ?? end?.toolName, "search", query)
    const args = events.filter((e) => e.type === "TOOL_CALL_ARGS").map((e) => e.delta).join("")
    assert.deepEqual(JSON.parse(args), { query }, query)
  }
})

test("cancelling a request queued behind another reply skips it and leaves the reply running", async () => {
  const { webLlmText } = await fresh()
  control.hold = new Promise((resolve) => (control.release = resolve))
  control.chunks = [delta({ role: "assistant", content: "Hi" })]
  let first = false
  let firstDone = false
  const running = (async () => {
    for await (const event of webLlmText(MODEL).chatStream(options())) {
      if (event.type === "TEXT_MESSAGE_CONTENT") first = true
    }
    firstDone = true
  })()
  while (!first) await new Promise((resolve) => setTimeout(resolve, 0))
  const controller = new AbortController()
  const queued = run(webLlmText(MODEL), { request: { signal: controller.signal } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await queued
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(control.interrupts, 0, "the queued request's cancel doesn't interrupt the running reply")
  assert.equal(firstDone, false, "the running reply goes on")
  control.release()
  await running
  assert.equal(control.prefills.length, 1, "the cancelled request never generates")
})

test("each load applies its catalog: a default adapter loads a stock model after a custom one, in both engines", async () => {
  const { webLlmText, webLlmEmbedding } = await fresh()
  const custom = (model_id: string, model_type?: number) => ({ model_list: [{ model_id, model: "https://example.com/m", model_lib: "https://example.com/m.wasm", ...(model_type !== undefined && { model_type }) }] })
  await webLlmText("Custom-Chat-MLC", { appConfig: custom("Custom-Chat-MLC") }).create()
  await webLlmText(MODEL).create()
  assert.deepEqual(control.reloads.map((r) => r.model), ["Custom-Chat-MLC", MODEL])

  const embedding = webLlmEmbedding("Custom-Embed-MLC", { appConfig: custom("Custom-Embed-MLC", 1) })
  await embedding.createEmbeddings({ logger, model: embedding.model, input: ["a"] })
  const stock = webLlmEmbedding()
  await stock.createEmbeddings({ logger, model: stock.model, input: ["a"] })
  assert.deepEqual(control.reloads.slice(2).map((r) => r.model), ["Custom-Embed-MLC", stock.model])
})

test("preload and unload wait for the running reply, in both engines", async () => {
  const { webLlmText, webLlmEmbedding } = await fresh()
  control.hold = new Promise((resolve) => (control.release = resolve))
  control.chunks = [delta({ role: "assistant", content: "Hi" })]
  let first = false
  const events: Array<Chunk> = []
  const running = (async () => {
    for await (const event of webLlmText(MODEL).chatStream(options())) {
      events.push(event)
      if (event.type === "TEXT_MESSAGE_CONTENT") first = true
    }
  })()
  while (!first) await new Promise((resolve) => setTimeout(resolve, 0))
  const preload = webLlmText(MODEL, { contextLength: 1024 }).create()
  const unload = webLlmText(MODEL, { contextLength: 1024 }).destroy()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(control.reloads.length, 1, "no reload during the reply")
  assert.equal(control.unloads, 0, "no unload during the reply")
  control.release()
  await Promise.all([running, preload, unload])
  assert.equal(control.interrupts, 0)
  assert.equal(events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join(""), "Hi")
  assert.deepEqual(control.reloads.map((r) => r.chatOptions), [undefined, { context_window_size: 1024 }])
  assert.equal(control.unloads, 1)

  // The embedding engine: an unload waits for the load before it.
  let open = () => undefined as void
  control.reloadGate = new Promise((resolve) => (open = resolve))
  const embedding = webLlmEmbedding()
  const loading = embedding.create()
  const unloading = embedding.destroy()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(control.unloads, 1, "no unload during the embedding load")
  open()
  await Promise.all([loading, unloading])
  assert.equal(control.unloads, 2)
})

test("an embedding batch keeps its engine: a preload with another catalog or an unload waits for it", async () => {
  const { webLlmEmbedding } = await fresh()
  let open = () => undefined as void
  control.embedHold = new Promise((resolve) => (open = resolve))
  const adapter = webLlmEmbedding()
  const batch = adapter.createEmbeddings({ logger, model: adapter.model, input: ["a"] })
  while (control.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  const custom = { model_list: [{ model_id: "Custom-Embed-MLC", model: "https://example.com/m", model_lib: "https://example.com/m.wasm", model_type: 1 }] }
  const preload = webLlmEmbedding("Custom-Embed-MLC", { appConfig: custom }).create()
  const unload = webLlmEmbedding("Custom-Embed-MLC", { appConfig: custom }).destroy()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(control.reloads.map((r) => r.model), [adapter.model], "no reload during the batch")
  assert.equal(control.unloads, 0, "no unload during the batch")
  open()
  const result = await batch
  await Promise.all([preload, unload])
  assert.equal(result.embeddings.length, 1)
  assert.deepEqual(control.reloads.map((r) => r.model), [adapter.model, "Custom-Embed-MLC"])
  assert.equal(control.unloads, 1)
})

test("a worker of your own holds the engine, shared by the adapters given it; the package's engines stay apart", async () => {
  const { webLlmText, webLlmEmbedding } = await fresh()
  const mine = new FakeWorker(true)
  await webLlmText(MODEL, { worker: mine }).create()
  await webLlmText(MODEL, { worker: mine }).create()
  assert.deepEqual(control.workers, [mine], "one engine for the worker")
  assert.equal(control.reloads.length, 1, "already loaded in it")
  await webLlmEmbedding(undefined, { worker: mine }).create()
  assert.deepEqual(control.workers, [mine], "embedding in the same worker shares its engine")
  await webLlmText(MODEL).create()
  assert.equal(control.workers.length, 2)
  assert.notEqual(control.workers[1], mine, "the package's own worker")
  await webLlmText(MODEL, { worker: mine }).destroy()
  assert.equal(control.unloads, 0, "the worker holds the embedding model now")
  await webLlmEmbedding(undefined, { worker: mine }).destroy()
  assert.equal(control.unloads, 1)
})

test("engineConfig: the log level is set at the load, WebLLM's reports are passed on, and its appConfig is the catalog", async () => {
  const { webLlmText } = await fresh()
  control.progress = [0.5, 1]
  const reports: Array<number> = []
  const custom = { model_list: [{ model_id: "Custom-MLC", model: "https://example.com/m", model_lib: "https://example.com/m.wasm" }] }
  const adapter = webLlmText("Custom-MLC", {
    engineConfig: { logLevel: "DEBUG", appConfig: custom, initProgressCallback: (report: { progress: number }) => reports.push(report.progress) }
  })
  await adapter.create()
  assert.deepEqual(control.logLevels, ["DEBUG"])
  assert.deepEqual(reports, [0.5, 1])
  assert.deepEqual(control.reloads.map((r) => r.model), ["Custom-MLC"], "found in engineConfig's catalog")
})

test("a worker of your own that fails to load rejects the load and every later one; the engine's turn is freed", async () => {
  const { webLlmText } = await fresh()
  const mine = new FakeWorker(true)
  control.reloadGate = new Promise(() => undefined)
  const adapter = webLlmText(MODEL, { worker: mine })
  const loading = adapter.create()
  await new Promise((resolve) => setTimeout(resolve, 5))
  mine.dispatch("error", {})
  await assert.rejects(loading, /failed to load its script/)
  // It never ran: nothing waits on it again.
  await assert.rejects(webLlmText(MODEL, { worker: mine }).create(), /failed to load its script/)
  const { events } = await run(adapter)
  assert.match(String(events.find((e) => e.type === "RUN_ERROR")?.message), /failed to load its script/)
})

test("the package's worker failing mid-reply ends the reply with its error; the next call starts a new worker", async () => {
  const { webLlmText } = await fresh()
  const before = FakeWorker.started.length
  control.hold = new Promise(() => undefined)
  const adapter = webLlmText(MODEL)
  const running = run(adapter)
  while (control.prefills.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  const worker = FakeWorker.started.at(-1) as FakeWorker
  worker.dispatch("message")
  worker.dispatch("error", { message: "out of memory" })
  const { events } = await running
  assert.match(String(events.find((e) => e.type === "RUN_ERROR")?.message), /WebLLM's worker failed: out of memory/)
  assert.ok(worker.terminated)
  control.hold = null
  await adapter.create()
  assert.equal(FakeWorker.started.length, before + 2, "a new worker for the next load")
  assert.equal(control.reloads.length, 2)
})

test("a worker of your own that failed before the adapter's first call rejects it at once", async () => {
  const { webLlmText } = await fresh()
  const mine = new FakeWorker(true)
  const adapter = webLlmText(MODEL, { worker: mine })
  mine.dispatch("error", {})
  await assert.rejects(adapter.create(), /failed to load its script/)
  assert.equal(control.reloads.length, 0)
})

test("usage keeps the cached count the worker adds, 0 included (TanStack's conversion leaves a 0 out)", async () => {
  for (const cached_tokens of [0, 352]) {
    control.chunks = [
      delta({ role: "assistant", content: "Hi" }),
      { ...delta({}, "stop"), usage: { prompt_tokens: 371, completion_tokens: 2, total_tokens: 373, prompt_tokens_details: { cached_tokens } } }
    ]
    const { events } = await run(webLlmText(MODEL))
    const usage = events.find((e) => e.type === "RUN_FINISHED")?.usage as { promptTokens: number; promptTokensDetails?: unknown }
    assert.equal(usage.promptTokens, 371)
    assert.deepEqual(usage.promptTokensDetails, { cachedTokens: cached_tokens })
  }
})
