/**
 * How Transformers.js keeps and runs models in a browser here, set through
 * its own public settings. Both are overrides to remove once Transformers.js
 * fixes them itself: daveycodez/tanstack-ai-browser#27 tracks them.
 *
 * - Downloads go to the origin's private file system (OPFS), through
 *   `env.customCache`. On a cache miss, Transformers.js 4.3.2 reads a whole
 *   file into memory and then hands the cache a second copy
 *   (`cache.put(key, new Response(buffer))`), so a 760 MB weights file
 *   peaks near 1.5 GB of JavaScript buffers and an iPhone Safari tab (2 GB)
 *   is killed as the download ends (huggingface/transformers.js#1827, and
 *   #1747 upstream for the JavaScript side). Here an ONNX file (a `.onnx`
 *   graph or its `.onnx_data`) is downloaded into OPFS piece by piece when
 *   Transformers.js first looks it up, and Transformers.js reads it as a
 *   cache hit: one copy.
 * - The weights Transformers.js reads are freed as soon as a load ends.
 *   Transformers.js reads each weights file whole into memory before ONNX
 *   Runtime puts it on the GPU, and Safari's garbage collector doesn't free
 *   that copy afterwards (in a worker, after a load, it was still alive 20 s
 *   later, where Chromium freed it within a second), so an iPhone tab held
 *   the weights twice and was killed at the first reply. Here Transformers.js
 *   reads ONNX files through `arrayBuffer()` of responses this cache makes
 *   (it does when it's given no progress callback), and when the load ends
 *   those buffers are detached (`ArrayBuffer.prototype.transfer(0)`), which
 *   frees them at once.
 * - ONNX Runtime's JSPI WebAssembly build where the browser has JSPI,
 *   through `env.backends.onnx.wasm.wasmPaths`, in place of the Asyncify
 *   build Transformers.js always picks (huggingface/transformers.js#1835):
 *   on Safari, about 730 MB lower peak and faster generation.
 */
/** The parts of Transformers.js's `env` used here. */
type TransformersEnv = {
  useCustomCache: boolean
  customCache: unknown
  cacheKey: string
  fetch: (url: string) => Promise<Response>
  backends: { onnx: { wasm?: { wasmPaths?: unknown } } }
}

/** The folder in OPFS. */
const FOLDER = "transformers-js"

/** The files downloaded into OPFS before Transformers.js reads them: ONNX graphs and their external data. */
const ONNX_FILE = /\.onnx(_data(_\d+)?)?$/

/** What's kept beside a file: its key (the URL) and size, so a file cut short isn't taken. */
type Entry = { key: string; size: number; type: string }

type Listener = (url: string, loaded: number, total: number) => void
const listeners = new Set<Listener>()

/** Whether this is Node.js, where Transformers.js keeps files in its own folder. */
const onNode = () => (globalThis as { process?: { release?: { name?: string } } }).process?.release?.name === "node"

const folder = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(FOLDER, { create: true })

/** A key's file name: its SHA-256, in hex. */
async function nameOf(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** A kept file and its entry, if it's whole. */
async function stored(dir: FileSystemDirectoryHandle, name: string) {
  try {
    const entry = JSON.parse(await (await (await dir.getFileHandle(`${name}.json`)).getFile()).text()) as Entry
    const file = await (await dir.getFileHandle(`${name}.bin`)).getFile()
    return file.size === entry.size ? { entry, file } : undefined
  } catch {
    return undefined
  }
}

/** Loads under way here (startLoad), and the buffers of ONNX files read during them, detached when the last ends. */
let loading = 0
const readDuringLoads = new Set<ArrayBuffer>()

/** A response whose `arrayBuffer()` is kept track of during a load, to be detached when it ends. */
class WeightsResponse extends Response {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = await super.arrayBuffer()
    if (loading > 0) readDuringLoads.add(buffer)
    return buffer
  }
}

/** A file as a response (an ONNX file's tracked, see WeightsResponse): its body is read from the file as it's consumed. */
const responseOf = (key: string, file: Blob, type: string) => {
  const init = { headers: { "content-length": String(file.size), "content-type": type } }
  return ONNX_FILE.test(new URL(key, "file:").pathname) ? new WeightsResponse(file, init) : new Response(file, init)
}

type SyncAccessHandle = { write(data: Uint8Array, options: { at: number }): number; truncate(size: number): void; flush(): void; close(): void }
type Writable = { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }

/**
 * Writes a body to a file a chunk at a time, so it's never whole in memory:
 * with a synchronous access handle in a worker, else a writable stream.
 * `progress` hears the bytes written so far.
 */
async function write(dir: FileSystemDirectoryHandle, name: string, body: ReadableStream<Uint8Array>, progress?: (written: number) => void) {
  await dir.removeEntry(`${name}.json`).catch(() => undefined)
  const handle = (await dir.getFileHandle(`${name}.bin`, { create: true })) as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<SyncAccessHandle>
    createWritable?: () => Promise<Writable>
  }
  const reader = body.getReader()
  let written = 0
  const inWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined"
  if (inWorker && handle.createSyncAccessHandle) {
    const access = await handle.createSyncAccessHandle()
    try {
      access.truncate(0)
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        written += access.write(read.value, { at: written })
        progress?.(written)
      }
      access.flush()
    } finally {
      access.close()
    }
  } else if (handle.createWritable) {
    const writable = (await handle.createWritable()) as unknown as Writable
    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        await writable.write(read.value)
        written += read.value.byteLength
        progress?.(written)
      }
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw error
    }
  } else {
    await reader.cancel().catch(() => undefined)
    throw new Error("This browser can't write files to OPFS here.")
  }
  return written
}

/**
 * A cache for Transformers.js's `env.customCache` (its `match` and `put`),
 * kept in OPFS. `match` finds a kept file; then Transformers.js's own Cache
 * Storage, where models downloaded before are; then, for an ONNX file on a
 * server, downloads it into OPFS and finds that. A failed download is a
 * miss, and Transformers.js downloads the file itself.
 */
function opfsCache(env: TransformersEnv) {
  const downloading = new Map<string, Promise<Response | undefined>>()

  /** Transformers.js's own Cache Storage, where it kept files before; not created here. */
  const before = async () =>
    typeof caches !== "undefined" && (await caches.has(env.cacheKey).catch(() => false)) ? caches.open(env.cacheKey) : undefined

  async function download(key: string, dir: FileSystemDirectoryHandle, name: string) {
    const response = await env.fetch(key)
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    const total = Number(response.headers.get("content-length")) || 0
    const size = await write(dir, name, response.body, (loaded) => {
      for (const listener of listeners) listener(key, loaded, total)
    })
    if (total && size !== total) throw new Error(`The download of ${key} stopped at ${size} of ${total} bytes.`)
    await writeEntry(dir, name, { key, size, type: response.headers.get("content-type") ?? "application/octet-stream" })
    const kept = await stored(dir, name)
    return kept && responseOf(key, kept.file, kept.entry.type)
  }

  return {
    async match(key: string): Promise<Response | undefined> {
      const dir = await folder()
      const name = await nameOf(key)
      const kept = await stored(dir, name)
      if (kept) return responseOf(key, kept.file, kept.entry.type)
      const old = await (await before())?.match(key)
      if (old) return responseOf(key, await old.blob(), old.headers.get("content-type") ?? "application/octet-stream")
      if (!/^https?:\/\//.test(key) || !ONNX_FILE.test(new URL(key).pathname)) return undefined
      let pending = downloading.get(key)
      if (!pending) {
        pending = download(key, dir, name).finally(() => downloading.delete(key))
        downloading.set(key, pending)
      }
      return pending
    },
    async put(key: string, response: Response): Promise<void> {
      if (!response.body) return
      const dir = await folder()
      const name = await nameOf(key)
      const size = await write(dir, name, response.body)
      await writeEntry(dir, name, { key, size, type: response.headers.get("content-type") ?? "application/octet-stream" })
    }
  }
}

/** Writes a file's entry (its key and size), which marks the file whole. */
async function writeEntry(dir: FileSystemDirectoryHandle, name: string, entry: Entry) {
  const handle = (await dir.getFileHandle(`${name}.json`, { create: true })) as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<SyncAccessHandle>
    createWritable?: () => Promise<Writable>
  }
  const bytes = new TextEncoder().encode(JSON.stringify(entry))
  const inWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined"
  if (inWorker && handle.createSyncAccessHandle) {
    const access = await handle.createSyncAccessHandle()
    try {
      access.truncate(0)
      access.write(bytes, { at: 0 })
      access.flush()
    } finally {
      access.close()
    }
  } else if (handle.createWritable) {
    const writable = (await handle.createWritable()) as unknown as Writable
    await writable.write(bytes)
    await writable.close()
  }
}

let set = false

/**
 * Sets Transformers.js up for this browser, once, before a model loads:
 * the OPFS cache (unless a cache of the caller's is set, or there's no
 * OPFS) and ONNX Runtime's JSPI build where the browser has JSPI (in place
 * of Transformers.js's default Asyncify build only). Nothing on Node.js.
 */
export function setUpTransformers(env: TransformersEnv): void {
  if (set || onNode()) return
  set = true
  const wasm = env.backends.onnx.wasm
  const paths = wasm?.wasmPaths as { mjs?: unknown; wasm?: unknown } | undefined
  if (
    wasm &&
    typeof WebAssembly !== "undefined" &&
    "Suspending" in WebAssembly &&
    typeof paths?.mjs === "string" &&
    typeof paths.wasm === "string" &&
    paths.mjs.endsWith("/ort-wasm-simd-threaded.asyncify.mjs")
  ) {
    // The same release's JSPI files, beside its Asyncify ones. Named as an
    // object, Transformers.js keeps both in its cache, for loading offline.
    wasm.wasmPaths = { mjs: paths.mjs.replace(/\.asyncify\.mjs$/, ".jspi.mjs"), wasm: paths.wasm.replace(/\.asyncify\.wasm$/, ".jspi.wasm") }
  }
  if (env.useCustomCache || typeof navigator === "undefined" || !navigator.storage?.getDirectory || !globalThis.crypto?.subtle) return
  env.customCache = opfsCache(env)
  env.useCustomCache = true
}

/**
 * Starts a model load here: `report` hears the OPFS cache's downloads, as
 * the load's progress over them, 0 to 1 (at most every 100 ms, never going
 * back), and 1 when it ends well. `end()` ends it; when no other load is
 * under way, the ONNX files' buffers read during the loads are detached,
 * freeing them (see the top of this file). Load with no Transformers.js
 * `progress_callback`, so it reads the files with `arrayBuffer()`.
 */
export function startLoad(report?: (progress: number) => void): { end: (loaded: boolean) => void } {
  loading++
  const downloads = new Map<string, { loaded: number; total: number }>()
  let reported = 0
  let last = Number.NEGATIVE_INFINITY
  const listener: Listener = (url, loaded, total) => {
    downloads.set(url, { loaded, total })
    let sum = 0
    let all = 0
    for (const file of downloads.values()) {
      sum += file.loaded
      all += file.total
    }
    const progress = all ? Math.min(1, sum / all) : 0
    const now = performance.now()
    if (progress <= reported || (now - last < 100 && progress < 1)) return
    reported = progress
    last = now
    report?.(progress)
  }
  listeners.add(listener)
  let ended = false
  return {
    end(loaded) {
      if (ended) return
      ended = true
      listeners.delete(listener)
      if (loaded && reported < 1) report?.(1)
      if (--loading > 0) return
      for (const buffer of readDuringLoads) (buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer }).transfer?.(0)
      readDuringLoads.clear()
    }
  }
}

/** Whether OPFS holds ONNX files of `model` (by its repo id in their URLs). */
export async function keptInOpfs(model: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return false
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(FOLDER)
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (!name.endsWith(".json") || handle.kind !== "file") continue
      const { key } = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as Entry
      if (key.includes(`/${model}/`) && ONNX_FILE.test(new URL(key).pathname)) return true
    }
    return false
  } catch {
    return false
  }
}
