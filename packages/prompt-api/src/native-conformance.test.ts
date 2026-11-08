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
const temporary = await mkdtemp(join(tmpdir(), "native-schema-contract-"))
after(() => rm(temporary, { recursive: true, force: true }))
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"], additionalProperties: false }
const controller = new AbortController()
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const control = { requests: [] as Array<Record<string, unknown>>, unsupported: false, discarded: 0 }
;(globalThis as { __nativeSchemaContract?: typeof control }).__nativeSchemaContract = control

async function adapterPackage(entry = "adapter") {
  const outfile = join(temporary, `prompt-api-${entry}.mjs`)
  await build({
    entryPoints: [join(root, "packages/prompt-api", `src/${entry}.ts`)], outfile, bundle: true,
    format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error",
    plugins: [{ name: "public-runtime-contract", setup(bundle) {
      bundle.onResolve({ filter: /^\.\/sessions\.js$/ }, args => args.importer.endsWith("/prompt-api/src/adapter.ts") ? { path: "prompt", namespace: "contract" } : undefined)
      bundle.onLoad({ filter: /.*/, namespace: "contract" }, () => ({ contents: `
        const control=globalThis.__nativeSchemaContract;
        export const destroyPromptApiSessions=()=>{};export const leaseSession=async()=>({cachedTokens:0,overflowed:()=>false,discard(){control.discarded++},session:{contextUsage:20,contextWindow:8192,measureContextUsage:async()=>5,prompt:async(input,options)=>{control.requests.push({input,options});if(control.unsupported)throw new DOMException('schema unsupported','NotSupportedError');return '{"moveId":"b6-a5"}'}}});
      ` }))
    } }]
  })
  return import(pathToFileURL(outfile).href)
}
function options(model: string, modelOptions: object = {}) {
  return { chatOptions: { logger, threadId: "native-contract", model, messages: [{ role: "user", content: "Choose a legal move" }], modelOptions, abortController: controller }, outputSchema: schema }
}

test("Prompt API passes the exact native schema and rejects unsupported schemas without downgrade or retry", async () => {
  const { promptApiText } = await adapterPackage()
  control.requests = []; control.unsupported = false; control.discarded = 0
  const adapter = promptApiText("built-in")
  assert.deepEqual((await adapter.structuredOutput(options(adapter.model))).data, { moveId: "b6-a5" })
  const first = control.requests[0].options as Record<string, unknown>
  assert.deepEqual(first.responseConstraint, schema)
  assert.equal(first.signal, controller.signal)
  control.unsupported = true
  await assert.rejects(adapter.structuredOutput(options(adapter.model)), /cannot enforce.*JSON Schema/)
  assert.equal(control.requests.length, 2, "one native request per call, without weaker schema fallback")
  assert.equal(control.discarded, 2, "isolated native sessions are discarded after success and failure")
  control.unsupported = false
})

test("Prompt API tool schemas preserve assertions instead of weakening them", async () => {
  const { inputSchemaOf } = await adapterPackage("tools")
  const inputSchema = {
    type: "object",
    properties: { query: { type: ["string", "null"], pattern: "^[a-z]+$", minLength: 4 }, count: { type: "integer", minimum: 1, maximum: 4 } },
    required: ["query"], additionalProperties: false,
    $defs: { tag: { type: "string", minLength: 2 } }
  }
  assert.equal(inputSchemaOf({ name: "search", inputSchema }), inputSchema)
  assert.deepEqual(inputSchemaOf({ name: "clock" }), { type: "object", properties: {}, required: [], additionalProperties: false })
  assert.throws(() => inputSchemaOf({ name: "search", inputSchema: false }), /Unsupported argument schema/)
})
