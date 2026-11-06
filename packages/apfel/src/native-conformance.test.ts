import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/apfel/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "native-schema-contract-"))
after(() => rm(temporary, { recursive: true, force: true }))
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"], additionalProperties: false }
const controller = new AbortController()
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }

async function adapterPackage() {
  const outfile = join(temporary, "apfel-adapter.mjs")
  await build({
    entryPoints: [join(root, "packages/apfel/src/adapter.ts")], outfile, bundle: true,
    format: "esm", platform: "node", conditions: ["@tanstack-ai-browser/source"], logLevel: "error"
  })
  return import(pathToFileURL(outfile).href)
}
function options(model: string, modelOptions: object = {}) {
  return { chatOptions: { logger, threadId: "native-contract", model, messages: [{ role: "user", content: "Choose a legal move" }], modelOptions, abortController: controller }, outputSchema: schema }
}

test("apfel forwards the exact guided schema and caller output cap, and rejects length completion", async () => {
  const { apfelText } = await adapterPackage()
  const adapter = apfelText("apple")
  const originalFetch = globalThis.fetch
  let sent: Record<string, unknown> = {}
  let finish = "stop"
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(init?.signal, controller.signal)
    return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: '{"moveId":"b6-a5"}' } }] }), { headers: { "content-type": "application/json" } })
  }
  try {
    assert.deepEqual((await adapter.structuredOutput(options(adapter.model, { maxCompletionTokens: 8192 }))).data, { moveId: "b6-a5" })
    assert.deepEqual(sent.response_format, { type: "json_schema", json_schema: { name: "output", schema } })
    assert.equal(sent.max_tokens, 8192)
    assert.equal("maxCompletionTokens" in sent, false)
    finish = "length"
    await assert.rejects(adapter.structuredOutput(options(adapter.model)), /cut off.*token limit/)
  } finally { globalThis.fetch = originalFetch }
})
