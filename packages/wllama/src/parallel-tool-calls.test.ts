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
const temporary = await mkdtemp(join(tmpdir(), "wllama-parallel-tools-"))
after(() => rm(temporary, { recursive: true, force: true }))

/** What the stubbed llama.cpp receives and streams back. */
const control = { requests: [] as Array<Record<string, unknown>>, chunks: [] as Array<unknown> }
;(globalThis as { __wllamaParallel?: typeof control }).__wllamaParallel = control

const outfile = join(temporary, "wllama-adapter.mjs")
await build({
  entryPoints: [join(root, "packages/wllama/src/adapter.ts")], outfile, bundle: true,
  format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error",
  plugins: [{ name: "stub-llama-cpp", setup(bundle) {
    bundle.onResolve({ filter: /^\.\/client\.js$/ }, args => args.importer.endsWith("/wllama/src/adapter.ts") ? { path: "client", namespace: "stub" } : undefined)
    bundle.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
      const control=globalThis.__wllamaParallel;
      export const configureRuntime=()=>{};export const setContextLength=()=>{};export const setKeepLoaded=()=>{};
      export const waitForModel=async()=>({});export const loadedContext=()=>32768;export const contextError=e=>e;
      export const streamChat=async function*(model,request){control.requests.push(request);yield* control.chunks;};
      export const completeChat=async(model,request)=>{control.requests.push(request);return {choices:[{finish_reason:"stop",message:{content:"{}"}}]}};
    ` }))
  } }]
})
type Chunk = { type: string; [key: string]: unknown }
type Adapter = { model: string; chatStream(options: Record<string, unknown>): AsyncIterable<Chunk> }
const { wllamaText } = await import(pathToFileURL(outfile).href) as { wllamaText: (model: string) => Adapter }

const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const tools = [{ name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }]
const call = (index: number, id: string, city: string) => [
  { choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify({ city }) } }] } }] }
]
/** llama.cpp's reply: two calls, as a template whose parser ignores `parallel_tool_calls` might return them. */
const twoCalls = [...call(0, "a", "Tokyo"), ...call(1, "b", "Paris"), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]

async function run(modelOptions: Record<string, unknown>, withTools = true) {
  const chunks: Array<Chunk> = []
  const adapter = wllamaText("LiquidAI/LFM3-1.7B-GGUF")
  for await (const chunk of adapter.chatStream({
    logger, model: adapter.model, threadId: "parallel", messages: [{ role: "user", content: "Weather in Tokyo and Paris?" }],
    ...(withTools && { tools }), modelOptions
  })) chunks.push(chunk)
  return chunks
}
const toolEvents = (chunks: Array<{ type: string }>) => chunks.map(c => c.type).filter(t => t.startsWith("TOOL_CALL_"))
const cities = (chunks: Array<Chunk>) =>
  chunks.filter(c => c.type === "TOOL_CALL_END").map(c => (c.input as { city: string }).city)

test("wllama sends parallelToolCalls false to llama.cpp and keeps one tool call", async () => {
  control.requests = []; control.chunks = twoCalls
  const chunks = await run({ parallelToolCalls: false })
  assert.equal(control.requests[0].parallel_tool_calls, false)
  assert.deepEqual(toolEvents(chunks), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"])
  assert.deepEqual(cities(chunks), ["Tokyo"])
  assert.equal(chunks.at(-1)?.finishReason, "tool_calls")
})

test("wllama keeps every tool call with parallelToolCalls true or unset, and leaves llama.cpp's default when unset", async () => {
  for (const [modelOptions, sent] of [[{ parallelToolCalls: true }, true], [{}, undefined]] as const) {
    control.requests = []; control.chunks = twoCalls
    const chunks = await run(modelOptions)
    assert.equal(control.requests[0].parallel_tool_calls, sent)
    assert.equal("parallel_tool_calls" in control.requests[0], sent !== undefined)
    assert.equal(chunks.filter(c => c.type === "TOOL_CALL_START").length, 2)
    assert.deepEqual(cities(chunks), ["Tokyo", "Paris"])
  }
})

test("wllama sends parallel_tool_calls only with tools, and rejects a non-boolean", async () => {
  control.requests = []; control.chunks = [{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]
  await run({ parallelToolCalls: false }, false)
  assert.equal("parallel_tool_calls" in control.requests[0], false)
  control.requests = []
  const chunks = await run({ parallelToolCalls: "no" })
  assert.equal(control.requests.length, 0, "an invalid option never reaches llama.cpp")
  assert.equal(chunks.at(-1)?.type, "RUN_ERROR")
  assert.match(String(chunks.at(-1)?.message), /parallelToolCalls must be a boolean/)
})
