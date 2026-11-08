import assert from "node:assert/strict"
import { test } from "node:test"

import { cachedDownload, removeOtherVersions } from "./download.js"
import type { DownloadProgress } from "./download.js"

/** A Cache Storage cache in memory. */
function memoryCache() {
  const entries = new Map<string, Response>()
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => {
      entries.set(url, response)
    },
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    delete: async (request: Request) => entries.delete(request.url)
  }
  return { cache: cache as unknown as Cache, entries }
}

const FILE = "data:application/octet-stream;base64,AAECAwQF"

test("a file is downloaded with progress, kept, and read from the cache the next time", async () => {
  const { cache, entries } = memoryCache()
  const first: Array<DownloadProgress> = []
  const bytes = await cachedDownload(FILE, cache, (p) => first.push(p))
  assert.deepEqual(Array.from(bytes), [0, 1, 2, 3, 4, 5])
  assert.equal(first[0]?.cached, false)
  assert.equal(first.at(-1)?.loadedBytes, 6)
  assert.ok(entries.has(FILE))

  const second: Array<DownloadProgress> = []
  const again = await cachedDownload(FILE, cache, (p) => second.push(p))
  assert.deepEqual(Array.from(again), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(second, [{ cached: true, loadedBytes: 6, totalBytes: 6 }])
})

test("without Cache Storage it still downloads", async () => {
  const bytes = await cachedDownload(FILE, undefined)
  assert.equal(bytes.byteLength, 6)
})

test("a failed download throws with its status", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("missing", { status: 404 })
  try {
    await assert.rejects(cachedDownload("https://example.com/x", undefined), /HTTP 404/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("other versions of MediaPipe's files are removed, the current one and other files kept", async () => {
  const { cache, entries } = memoryCache()
  const prefix = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@"
  for (const url of [
    `${prefix}1.2.1/wasm/a.wasm`,
    `${prefix}1.2.2/wasm/a.wasm`,
    "https://storage.googleapis.com/model.tflite"
  ]) {
    await cache.put(url, new Response("x"))
  }
  await removeOtherVersions(cache, prefix, `${prefix}1.2.2/wasm`)
  assert.deepEqual(
    [...entries.keys()],
    [`${prefix}1.2.2/wasm/a.wasm`, "https://storage.googleapis.com/model.tflite"]
  )
})
