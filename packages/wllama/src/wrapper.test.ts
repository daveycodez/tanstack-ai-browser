/**
 * What the adapter adds to TanStack's Chat Completions adapter: llama.cpp's
 * request fields over the model card's sampling, the chat template's thinking
 * switch, reading thinking, schemas as given, and the caller's signal
 * reaching wllama. llama.cpp is stubbed.
 */
import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/wllama/package.json"))
const { build } = (await import(pathToFileURL(require.resolve("esbuild")).href)) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "wllama-wrapper-"))
after(() => rm(temporary, { recursive: true, force: true }))

/** What the stubbed llama.cpp receives, and the chunks it streams back. */
const control = {
  requests: [] as Array<{ request: Record<string, unknown>; signal?: AbortSignal }>,
  chunks: [] as Array<unknown>
}
;(globalThis as { __wllamaWrapper?: typeof control }).__wllamaWrapper = control

const outfile = join(temporary, "wllama-adapter.mjs")
await build({
  entryPoints: [join(root, "packages/wllama/src/adapter.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  conditions: ["@tanstack-ai-browser/source"],
  logLevel: "error",
  plugins: [
    {
      name: "stub-llama-cpp",
      setup(bundle) {
        bundle.onResolve({ filter: /^\.\/client\.js$/ }, (args) =>
          args.importer.endsWith("/wllama/src/adapter.ts") ? { path: "client", namespace: "stub" } : undefined
        )
        bundle.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `
            const control=globalThis.__wllamaWrapper;
            export const availability=async()=>"available";export const unloadModel=async()=>{};
            export const loadModel=async()=>({
              createChatCompletion:async({abortSignal,...request})=>{
                control.requests.push({request,signal:abortSignal});
                if(request.stream) return (async function*(){yield* control.chunks})();
                return {choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:'{"city":"Oslo"}'}}]};
              }
            });
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
}
const { wllamaText } = (await import(pathToFileURL(outfile).href)) as { wllamaText: (model: string) => Adapter }

const MODEL = "unsloth/Qwen3.5-2B-GGUF"
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const options = (extra: Record<string, unknown> = {}) => ({
  logger,
  model: MODEL,
  threadId: "wrapper",
  messages: [{ role: "user", content: "hi" }],
  ...extra
})
const delta = (d: object, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta: d, finish_reason: finish }] })

async function run(extra: Record<string, unknown> = {}) {
  const events: Array<Chunk> = []
  for await (const event of wllamaText(MODEL).chatStream(options(extra))) events.push(event)
  return { events, request: control.requests.at(-1)!.request }
}

beforeEach(() => {
  control.requests = []
  control.chunks = [delta({ role: "assistant", content: "Hi" }), delta({}, "stop")]
})

test("modelOptions go to llama.cpp as given, over the model card's sampling", async () => {
  const given = { max_tokens: 64, temperature: 0.2, top_p: 0.9, min_p: 0.05, frequency_penalty: 0.1, presence_penalty: 0.5, seed: 7, stop: ["END"] }
  const { request } = await run({ modelOptions: given })
  for (const [key, value] of Object.entries(given)) assert.deepEqual(request[key], value, key)
  // Left out: the model card's.
  const card = (await run()).request
  assert.equal(typeof card.top_k, "number")
  assert.equal(typeof card.repeat_penalty, "number")
})

test("Qwen3.5's card sampling: its non-thinking settings by default, its thinking settings while thinking", async () => {
  const plain = (await run()).request
  assert.deepEqual(
    [plain.temperature, plain.top_p, plain.top_k, plain.min_p, plain.presence_penalty, plain.repeat_penalty],
    [1, 1, 20, 0, 2, 1]
  )
  const thinking = (await run({ reasoning: { level: "high", summary: false } })).request
  assert.deepEqual([thinking.top_p, thinking.presence_penalty], [0.95, 1.5])
})

test("parallel_tool_calls goes to llama.cpp as given; the request asks for usage", async () => {
  const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }]
  const request = (await run({ tools, modelOptions: { parallel_tool_calls: false } })).request
  assert.equal(request.parallel_tool_calls, false)
  assert.deepEqual(request.stream_options, { include_usage: true })
})

test("reasoning: the chat template's enable_thinking, a budget when thinking, nothing when not asked", async () => {
  const off = (await run({ reasoning: { level: "off", summary: false } })).request
  assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false })
  assert.equal(off.reasoning_effort, undefined)
  const high = (await run({ reasoning: { level: "high", summary: false, budgetTokens: 256 } })).request
  assert.deepEqual(high.chat_template_kwargs, { enable_thinking: true })
  assert.equal(high.reasoning_budget_tokens, 256)
  assert.equal((await run()).request.chat_template_kwargs, undefined)
})

test("thinking streamed as reasoning_content comes back as REASONING events", async () => {
  control.chunks = [delta({ role: "assistant", reasoning_content: "Let me think." }), delta({ content: "Hi" }), delta({}, "stop")]
  const { events } = await run()
  assert.equal(events.find((e) => e.type === "REASONING_MESSAGE_CONTENT")?.delta, "Let me think.")
})

test("structured output sends the schema as given; the caller's signal reaches wllama", async () => {
  const schema = { type: "object", properties: { city: { type: "string" }, note: { type: "string" } }, required: ["city"] }
  const controller = new AbortController()
  const result = await wllamaText(MODEL).structuredOutput({
    chatOptions: options({ request: { signal: controller.signal } }),
    outputSchema: schema
  })
  assert.deepEqual(result.data, { city: "Oslo" })
  const sent = control.requests.at(-1)!
  assert.deepEqual((sent.request.response_format as { json_schema: { schema: unknown } }).json_schema.schema, schema)
  assert.equal(sent.signal, controller.signal)
})

test("an audio clip and an image reach llama.cpp as their bytes, in their places", async () => {
  // A WAV file's first bytes, and three of an image.
  const wav = Uint8Array.from([..."RIFF", 0, 0, 0, 0, ..."WAVE", 7, 8, 9].map((v) => (typeof v === "string" ? v.charCodeAt(0) : v)))
  const data = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
  const content = [
    { type: "audio", source: { type: "data", value: data(wav), mimeType: "audio/wav" } },
    { type: "text", content: "What is said here, and what is in the picture?" },
    { type: "image", source: { type: "data", value: data(Uint8Array.from([1, 2, 3])), mimeType: "image/png" } }
  ]
  const { request } = await run({ messages: [{ role: "user", content }] })
  const messages = request.messages as Array<{ content: Array<{ type: string; data?: ArrayBuffer }> }>
  const parts = messages.at(-1)?.content ?? []
  assert.deepEqual(parts.map((part) => part.type), ["audio", "text", "image"])
  const [audio, , image] = parts
  assert.deepEqual(new Uint8Array(audio?.data ?? new ArrayBuffer(0)), wav)
  assert.deepEqual([...new Uint8Array(image?.data ?? new ArrayBuffer(0))], [1, 2, 3])
})

test("audio kept as an uploaded file is refused: wllama reads bytes", async () => {
  const content = [{ type: "audio", source: { type: "file", value: "file-123" } }]
  const events: Array<Chunk> = []
  for await (const event of wllamaText(MODEL).chatStream(options({ messages: [{ role: "user", content }] }))) events.push(event)
  const failure = events.find((event) => event.type === "RUN_ERROR")
  assert.match(JSON.stringify(failure), /not as uploaded files/)
  assert.equal(control.requests.length, 0)
})
