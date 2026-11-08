import assert from "node:assert/strict"
import { test } from "node:test"

import { download, loadWithCache, removeOtherVersions } from "./download.js"
import type { Download, DownloadProgress } from "./download.js"

/** A Cache Storage cache in memory. */
function memoryCache() {
  const entries = new Map<string, Response>()
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => {
      entries.set(url, response)
    },
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    delete: async (request: Request | string) =>
      entries.delete(typeof request === "string" ? request : request.url)
  }
  return { cache: cache as unknown as Cache, entries }
}

const FILE = "data:application/octet-stream;base64,AAECAwQF"

/** A "load" that accepts only the bytes 0-5. */
const create = async (files: Array<Download>) => {
  const bytes = Array.from(files[0]?.bytes ?? [])
  if (bytes.join() !== "0,1,2,3,4,5") throw new Error("not a model")
  return files.map((file) => file.cached)
}

test("a file is downloaded with progress", async () => {
  const progress: Array<DownloadProgress> = []
  const file = await download(FILE, undefined, (p) => progress.push(p))
  assert.deepEqual(Array.from(file.bytes), [0, 1, 2, 3, 4, 5])
  assert.equal(file.cached, false)
  assert.equal(file.type, "application/octet-stream")
  assert.equal(progress[0]?.cached, false)
  assert.equal(progress.at(-1)?.loadedBytes, 6)
})

test("a failed download throws with its status", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("missing", { status: 404 })
  try {
    await assert.rejects(download("https://example.com/x", undefined), /HTTP 404/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("files are kept once they load, and read from the cache the next time", async () => {
  const { cache, entries } = memoryCache()
  assert.deepEqual(await loadWithCache([FILE], cache, create), [false])
  assert.ok(entries.has(FILE))
  const progress: Array<DownloadProgress> = []
  assert.deepEqual(await loadWithCache([FILE], cache, create, (_, p) => progress.push(p)), [true])
  assert.deepEqual(progress, [{ cached: true, loadedBytes: 6, totalBytes: 6 }])
})

test("a file that doesn't load is never kept", async () => {
  const { cache, entries } = memoryCache()
  const html = "data:text/html,<html>not found</html>"
  await assert.rejects(loadWithCache([html], cache, create), /not a model/)
  assert.equal(entries.size, 0)
})

test("a bad file in the cache is deleted and downloaded again", async () => {
  const { cache, entries } = memoryCache()
  await cache.put(FILE, new Response("<html>a captive portal</html>"))
  const fetched: Array<string> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    fetched.push(String(input))
    return realFetch(input, init)
  }
  try {
    assert.deepEqual(await loadWithCache([FILE], cache, create), [false])
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(fetched, [FILE])
  const kept = await entries.get(FILE)?.clone().arrayBuffer()
  assert.deepEqual(Array.from(new Uint8Array(kept ?? new ArrayBuffer(0))), [0, 1, 2, 3, 4, 5])
})

test("a load that fails from the network too throws, keeping nothing", async () => {
  const { cache, entries } = memoryCache()
  await cache.put(FILE, new Response("bad"))
  await assert.rejects(
    loadWithCache([FILE], cache, async () => {
      throw new Error("broken")
    }),
    /broken/
  )
  assert.equal(entries.size, 0)
})

test("without Cache Storage it still loads", async () => {
  assert.deepEqual(await loadWithCache([FILE], undefined, create), [false])
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
