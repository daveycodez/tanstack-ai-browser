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
  cached: new Set<string>(),
  /** Progress values each reload reports. */
  progress: [] as Array<number>,
  /** Each reload waits for this. */
  reloadGate: Promise.resolve() as Promise<void>,
  chunks: [] as Array<unknown>,
  /** A streaming reply waits for this after its chunks (an interrupt resolves it). */
  hold: null as Promise<void> | null,
  release: () => undefined as void
}
;(globalThis as { __webLlm?: typeof control }).__webLlm = control
;(globalThis as { Worker?: unknown }).Worker = class {}

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
            export const prebuiltAppConfig={model_list:[{model_id:"Qwen3-1.7B-q4f16_1-MLC"},{model_id:"Qwen2.5-0.5B-Instruct-q4f16_1-MLC"},{model_id:"Phi-3.5-vision-instruct-q4f16_1-MLC",model_type:2},{model_id:"snowflake-arctic-embed-s-q0f32-MLC-b4",model_type:1}]};
            export class WebWorkerMLCEngine{
              constructor(worker,config){
                this.report=config.initProgressCallback;
                this.chat={completions:{create:async(request)=>{
                  control.requests.push(request);
                  if(request.stream) return (async function*(){yield* control.chunks;if(control.hold) await control.hold})();
                  return {choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:'{"city":"Oslo"}'}}]};
                }}};
                this.embeddings={create:async(request)=>{
                  control.requests.push(request);
                  return {data:request.input.map((_,index)=>({index,embedding:[index,1]})),usage:{prompt_tokens:3,total_tokens:3}};
                }};
              }
              setAppConfig(){}
              async reload(model,chatOptions){
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
type EmbeddingAdapter = { model: string; createEmbeddings(options: Record<string, unknown>): Promise<{ embeddings: Array<{ vector: Array<number>; index: number }> }> }
type Module = {
  webLlmText: (model: string, config?: Record<string, unknown>) => Adapter & { inputModalities: ReadonlyArray<string> }
  webLlmEmbedding: (model?: string) => EmbeddingAdapter
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
  control.cached = new Set()
  control.progress = []
  control.reloadGate = Promise.resolve()
  control.chunks = [delta({ role: "assistant", content: "Hi" }), delta({}, "stop")]
  control.hold = null
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
