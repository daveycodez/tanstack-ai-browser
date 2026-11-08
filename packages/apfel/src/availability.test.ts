import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { apfelText } from "./adapter.js"

const baseURL = "http://apfel.test/v1"
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("available when apfel lists the model at the adapter's baseURL; it reports 1, as nothing downloads", async () => {
  const asked: Array<{ url: string; headers: unknown }> = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked.push({ url, headers: init.headers })
    return Response.json({ data: [{ id: "apple-foundationmodel" }] })
  }) as typeof fetch
  const adapter = apfelText("apple-foundationmodel", { baseURL, defaultHeaders: { Authorization: "Bearer t" } })
  assert.equal(await adapter.availability(), "available")
  assert.deepEqual(asked[0], { url: `${baseURL}/models`, headers: { Authorization: "Bearer t" } })
  const progress: Array<number> = []
  assert.equal(await adapter.createSessionWithProgress((value) => progress.push(value)), adapter)
  assert.deepEqual(progress, [1])
  await adapter.destroySession()
})

test("unavailable when apfel doesn't answer, fails, or doesn't serve the model; loading rejects", async () => {
  const adapter = apfelText("apple-foundationmodel", { baseURL })
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as typeof fetch
  assert.equal(await adapter.availability(), "unavailable")
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    void adapter.createSessionWithProgress()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  await assert.rejects(adapter.createSessionWithProgress(), /didn't answer/)
  globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch
  assert.equal(await adapter.availability(), "unavailable")
  globalThis.fetch = (async () => Response.json({ data: [{ id: "other" }] })) as typeof fetch
  assert.equal(await adapter.availability(), "unavailable")
})

test("createSessionWithProgress's signal: aborted before, nothing is asked; aborting during the check rejects at once and reports nothing", async () => {
  let asked = 0
  let requestSignal: AbortSignal | undefined
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    asked++
    requestSignal = init.signal ?? undefined
    return new Promise<Response>(() => undefined)
  }) as typeof fetch
  const adapter = apfelText("apple-foundationmodel", { baseURL })
  await assert.rejects(adapter.createSessionWithProgress(undefined, { signal: AbortSignal.abort() }), (error: unknown) => error instanceof DOMException && error.name === "AbortError")
  assert.equal(asked, 0)
  const heard: Array<number> = []
  const controller = new AbortController()
  const checking = adapter.createSessionWithProgress((value) => heard.push(value), { signal: controller.signal })
  controller.abort()
  await assert.rejects(checking, { name: "AbortError" })
  assert.equal(requestSignal?.aborted, true, "the request was stopped")
  assert.deepEqual(heard, [])
})
