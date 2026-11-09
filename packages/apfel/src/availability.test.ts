import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { apfelText } from "./adapter.js"

const baseURL = "http://apfel.test/v1"
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("available when apfel lists the model at the adapter's baseURL; create resolves to the adapter", async () => {
  const asked: Array<{ url: string; headers: unknown }> = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked.push({ url, headers: init.headers })
    return Response.json({ data: [{ id: "apple-foundationmodel" }] })
  }) as typeof fetch
  const adapter = apfelText("apple-foundationmodel", { baseURL, defaultHeaders: { Authorization: "Bearer t" } })
  assert.equal(await adapter.availability(), "available")
  assert.deepEqual(asked[0], { url: `${baseURL}/models`, headers: { Authorization: "Bearer t" } })
  assert.equal(await adapter.create(), adapter)
})

test("unavailable when apfel doesn't answer, fails, or doesn't serve the model; create rejects", async () => {
  const adapter = apfelText("apple-foundationmodel", { baseURL })
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as typeof fetch
  assert.equal(await adapter.availability(), "unavailable")
  await assert.rejects(adapter.create(), /didn't answer/)
  globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch
  assert.equal(await adapter.availability(), "unavailable")
  globalThis.fetch = (async () => Response.json({ data: [{ id: "other" }] })) as typeof fetch
  assert.equal(await adapter.availability(), "unavailable")
})

test("create's signal: aborted before, nothing is asked; aborting during the check stops it with an AbortError", async () => {
  let asked = 0
  let requestSignal: AbortSignal | undefined
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    asked++
    requestSignal = init.signal ?? undefined
    return new Promise<Response>((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    )
  }) as typeof fetch
  const adapter = apfelText("apple-foundationmodel", { baseURL })
  await assert.rejects(adapter.create({ signal: AbortSignal.abort() }), { name: "AbortError" })
  assert.equal(asked, 0)
  const controller = new AbortController()
  const checking = adapter.create({ signal: controller.signal })
  controller.abort()
  await assert.rejects(checking, { name: "AbortError" })
  assert.equal(requestSignal?.aborted, true, "the request was stopped")
})
