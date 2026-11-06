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
const temporary = await mkdtemp(join(tmpdir(), "native-schema-contract-"))
after(() => rm(temporary, { recursive: true, force: true }))
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"], additionalProperties: false }
const controller = new AbortController()
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const control = { requests: [] as Array<Record<string, unknown>>, finish: "stop" }
;(globalThis as { __nativeSchemaContract?: typeof control }).__nativeSchemaContract = control

async function adapterPackage() {
  const outfile = join(temporary, "wllama-adapter.mjs")
  await build({
    entryPoints: [join(root, "packages/wllama/src/adapter.ts")], outfile, bundle: true,
    format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error",
    plugins: [{ name: "public-runtime-contract", setup(bundle) {
      bundle.onResolve({ filter: /^\.\/client\.js$/ }, args => args.importer.endsWith("/wllama/src/adapter.ts") ? { path: "wllama", namespace: "contract" } : undefined)
      bundle.onLoad({ filter: /.*/, namespace: "contract" }, () => ({ contents: `
        const control=globalThis.__nativeSchemaContract;
        export const configureRuntime=()=>{}; export const setContextLength=()=>{};export const setKeepLoaded=()=>{};
        export const waitForModel=async()=>{};export const loadedContext=()=>32768;export const contextError=()=>undefined;
        export const streamChat=async function*(model,request,signal){control.requests.push({model,request,signal});yield {choices:[{delta:{content:"hello"},finish_reason:"stop"}]};};
        export const completeChat=async(model,request,signal)=>{control.requests.push({model,request,signal});return {choices:[{finish_reason:control.finish,message:{content:'{"moveId":"b6-a5"}'}}]}};
      ` }))
    } }]
  })
  return import(pathToFileURL(outfile).href)
}
function options(model: string, modelOptions: object = {}) {
  return { chatOptions: { logger, threadId: "native-contract", model, messages: [{ role: "user", content: "Choose a legal move" }], modelOptions, abortController: controller }, outputSchema: schema }
}

test("wllama delegates the exact schema, thinking switch and output cap, and rejects length completion", async () => {
  const { wllamaText } = await adapterPackage()
  control.requests = []; control.finish = "stop"
  const adapter = wllamaText("LiquidAI/LFM3-1.7B-GGUF")
  const request = options(adapter.model, { maxCompletionTokens: 8192, response_format: { type: "text" } })
  const result = await adapter.structuredOutput({ ...request, chatOptions: { ...request.chatOptions, reasoning: { level: "high", summary: true } } })
  assert.deepEqual(result.data, { moveId: "b6-a5" })
  const sent = control.requests[0]
  const settings = sent.request as Record<string, unknown>
  assert.deepEqual(settings.response_format, { type: "json_schema", json_schema: { name: "output", schema, strict: true } })
  assert.deepEqual(settings.chat_template_kwargs, { enable_thinking: true })
  assert.equal(settings.max_tokens, 8192)
  assert.equal("maxTokens" in settings, false)
  assert.equal("max_new_tokens" in settings, false)
  assert.equal(sent.signal, controller.signal)
  control.finish = "length"
  await assert.rejects(adapter.structuredOutput(request), /output limit/)
})

test("wllama maps explicit thinking budgets through its public runtime option in both paths", async () => {
  const { wllamaText } = await adapterPackage()
  control.requests = [];control.finish = "stop"
  const adapter = wllamaText("LiquidAI/LFM3-1.7B-GGUF")
  const reasons = [undefined, { level: "high", summary: true, budgetTokens: 512 }, { level: "high", summary: true, budgetTokens: 0 }, { level: "off", summary: true, budgetTokens: 512 }, { level: "high", summary: true }]
  for (const reasoning of reasons) {
    const request = options(adapter.model)
    const chatOptions = { ...request.chatOptions, ...(reasoning && { reasoning }) }
    await adapter.structuredOutput({ ...request, chatOptions })
    for await (const chunk of adapter.chatStream(chatOptions)) assert.ok(chunk)
  }
  const settings = control.requests.map(r => r.request as Record<string, unknown>)
  assert.deepEqual(settings.map(s => s.reasoning_budget_tokens), [undefined,undefined,512,512,0,0,undefined,undefined,undefined,undefined])
  assert.deepEqual(settings.map(s => s.chat_template_kwargs), [undefined,undefined,{enable_thinking:true},{enable_thinking:true},{enable_thinking:true},{enable_thinking:true},{enable_thinking:false},{enable_thinking:false},{enable_thinking:true},{enable_thinking:true}])
  assert.ok(settings.every(s => !("budgetTokens" in s) && !("reasoning" in s) && !("summary" in s)))
  const precedence = options(adapter.model, { reasoning_budget_tokens: 9999 })
  await adapter.structuredOutput({ ...precedence, chatOptions: { ...precedence.chatOptions, reasoning: { level: "high", summary: true, budgetTokens: 512 } } })
  assert.equal((control.requests.at(-1)?.request as Record<string, unknown>).reasoning_budget_tokens, 512)
  for (const budgetTokens of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const before = control.requests.length
    const request = options(adapter.model)
    const chatOptions = { ...request.chatOptions, reasoning: { level: "high", summary: true, budgetTokens } }
    await assert.rejects(adapter.structuredOutput({ ...request, chatOptions }), /nonnegative safe integer/)
    await assert.rejects(async () => { for await (const chunk of adapter.chatStream(chatOptions)) assert.ok(chunk) }, /nonnegative safe integer/)
    assert.equal(control.requests.length, before)
  }
  const plain = wllamaText("LiquidAI/LFM2.5-1.2B-Instruct-GGUF")
  const request = options(plain.model)
  await assert.rejects(plain.structuredOutput({ ...request, chatOptions: { ...request.chatOptions, reasoning: { level: "high", summary: true, budgetTokens: 512 } } }), /does not support a thinking token budget/)
})
