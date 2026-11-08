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
