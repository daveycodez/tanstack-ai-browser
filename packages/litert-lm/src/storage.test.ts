import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { downloadFile, MODEL_CACHE, readFile, removeFile, storedFile } from "./storage.js"
import type { StorageEnvironment } from "./storage.js"

const MODEL = "owner/model"
const FILE = { url: "https://huggingface.co/owner/model/resolve/abc123/model.litertlm" }

/** Cache Storage in memory: an entry appears once its body has been read whole. */
class FakeCaches {
  opened: Array<string> = []
  entries = new Map<string, { bytes: Uint8Array; headers: Headers }>()
  async open(name: string) {
    this.opened.push(name)
    const entries = this.entries
    return {
      async match(request: string) {
        const entry = entries.get(request)
        return entry ? new Response(entry.bytes.slice(), { headers: entry.headers }) : undefined
      },
      async put(request: string, response: Response) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        entries.set(request, { bytes, headers: response.headers })
      },
      async delete(request: string) {
        return entries.delete(request)
      }
    } as unknown as Cache
  }
}

let caches: FakeCaches
let requests: Array<{ url: string; init: RequestInit | undefined }>
let answer: () => Response

const env = (): StorageEnvironment => ({
  caches,
  fetch: async (url, init) => {
    requests.push({ url, init })
    return answer()
  }
})

/** A response of `chunks` chunks of ten bytes each. */
const body = (chunks: number, headers: Record<string, string> = { "Content-Length": String(chunks * 10) }) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(10).fill(i + 1))
        controller.close()
      }
    }),
    { headers }
  )

beforeEach(() => {
  caches = new FakeCaches()
  requests = []
  answer = () => body(4)
})

test("a download is stored under its URL, with what the name resolved to beside it", async () => {
  const heard: Array<number> = []
  assert.equal(await storedFile(MODEL, env()), undefined)
  await downloadFile(MODEL, FILE, { onProgress: (value) => heard.push(value) }, env())
  assert.deepEqual(heard, [0.25, 0.5, 0.75, 0.999])
  assert.deepEqual(await storedFile(MODEL, env()), { url: FILE.url, size: 40 })
  assert.ok(caches.opened.every((name) => name === MODEL_CACHE))
  const stream = await readFile(FILE, env())
  assert.equal((await new Response(stream).arrayBuffer()).byteLength, 40)
})

test("progress goes by the file's known size where the server gives none", async () => {
  answer = () => body(2, {})
  const heard: Array<number> = []
  await downloadFile(MODEL, { ...FILE, size: 20 }, { onProgress: (value) => heard.push(value) }, env())
  assert.deepEqual(heard, [0.5, 0.999])
  const silent: Array<number> = []
  await downloadFile("owner/other", { url: "https://example.com/other.litertlm" }, { onProgress: (value) => silent.push(value) }, env())
  assert.deepEqual(silent, [])
})

test("an access token goes with the request and isn't stored", async () => {
  await downloadFile(MODEL, FILE, { accessToken: "hf_user" }, env())
  assert.deepEqual(requests[0].init?.headers, { Authorization: "Bearer hf_user" })
  for (const entry of caches.entries.values()) {
    assert.ok(!new TextDecoder().decode(entry.bytes).includes("hf_user"))
    assert.equal(entry.headers.get("Authorization"), null)
  }
})

test("a refused download fails with a code and stores nothing", async () => {
  answer = () => new Response("no", { status: 403 })
  await assert.rejects(downloadFile(MODEL, FILE, {}, env()), (error: { code?: string; message: string }) => error.code === "unauthorized" && /gated/.test(error.message))
  answer = () => new Response("gone", { status: 500 })
  await assert.rejects(downloadFile(MODEL, FILE, {}, env()), (error: { code?: string }) => error.code === "download-failed")
  assert.equal(caches.entries.size, 0)
  assert.equal(await storedFile(MODEL, env()), undefined)
})

test("a download whose bytes can't be stored fails, and the model isn't stored", async () => {
  const failing: StorageEnvironment = {
    fetch: env().fetch,
    caches: {
      open: async () =>
        ({
          match: async () => undefined,
          put: async () => {
            throw new DOMException("no room", "QuotaExceededError")
          },
          delete: async () => false
        }) as unknown as Cache
    }
  }
  await assert.rejects(downloadFile(MODEL, FILE, {}, failing), (error: { code?: string }) => error.code === "storage-full")
})

test("a model whose file is gone isn't stored, whatever its record says", async () => {
  await downloadFile(MODEL, FILE, {}, env())
  caches.entries.delete(FILE.url)
  assert.equal(await storedFile(MODEL, env()), undefined)
  assert.equal(await readFile(FILE, env()), undefined)
})

test("removing a model removes its file and its record", async () => {
  await downloadFile(MODEL, FILE, {}, env())
  assert.equal(await removeFile(MODEL, env()), true)
  assert.equal(caches.entries.size, 0)
  assert.equal(await removeFile(MODEL, env()), false)
})

test("without Cache Storage nothing is stored, and a download says so", async () => {
  assert.equal(await storedFile(MODEL, undefined), undefined)
  assert.equal(await removeFile(MODEL, undefined), false)
  // (Node has no `caches`: the default environment is none.)
  await assert.rejects(downloadFile(MODEL, FILE), (error: { code?: string }) => error.code === "unavailable")
})
