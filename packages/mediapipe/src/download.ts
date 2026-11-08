/**
 * Downloads files once and keeps them in Cache Storage, so later loads read
 * them from there, offline too. A file is kept only once MediaPipe has
 * loaded it, so a bad response (an error page with a 200) is never kept.
 * Where there's no Cache Storage (an insecure context), files are
 * downloaded each time.
 */

/** The Cache Storage cache the adapter keeps its files in. */
export const CACHE_NAME = "tanstack-ai-browser-mediapipe"

export type DownloadProgress = {
  /** True when the file came from the cache. */
  cached: boolean
  loadedBytes: number
  /** Bytes of the file, when the server says (or the cache has it). */
  totalBytes?: number
}

/** A file's bytes, and where they came from. */
export type Download = {
  url: string
  bytes: Uint8Array<ArrayBuffer>
  /** True when they came from the cache. */
  cached: boolean
  /** The response's Content-Type. */
  type: string
}

/** The adapter's cache, or undefined where there's no Cache Storage. */
export async function openCache(): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return undefined
  }
}

/** The bytes of `url`, from `cache` if it has them, else from the network. */
export async function download(
  url: string,
  cache: Cache | undefined,
  onProgress?: (progress: DownloadProgress) => void
): Promise<Download> {
  const hit = await cache?.match(url).catch(() => undefined)
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer())
    onProgress?.({ cached: true, loadedBytes: bytes.byteLength, totalBytes: bytes.byteLength })
    const type = hit.headers.get("Content-Type") ?? "application/octet-stream"
    return { url, bytes, cached: true, type }
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Couldn't download ${url}: HTTP ${response.status}.`)
  }
  const length = Number(response.headers.get("Content-Length"))
  const totalBytes = length > 0 ? length : undefined
  const chunks: Array<Uint8Array> = []
  let loadedBytes = 0
  onProgress?.({ cached: false, loadedBytes, totalBytes })
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loadedBytes += value.byteLength
      onProgress?.({ cached: false, loadedBytes, totalBytes })
    }
  }
  const bytes = new Uint8Array(loadedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const type = response.headers.get("Content-Type") ?? "application/octet-stream"
  return { url, bytes, cached: false, type }
}

/**
 * Downloads `urls` (from `cache` where it has them) and loads them with
 * `create`. Once that succeeds, the files that came from the network are
 * kept in the cache. If it fails with files from the cache, they're deleted
 * from it and the load is tried once more from the network.
 */
export async function loadWithCache<T>(
  urls: ReadonlyArray<string>,
  cache: Cache | undefined,
  create: (files: Array<Download>) => Promise<T>,
  onProgress?: (url: string, progress: DownloadProgress) => void
): Promise<T> {
  const attempt = async (from: Cache | undefined) => {
    const files = await Promise.all(
      urls.map((url) => download(url, from, (progress) => onProgress?.(url, progress)))
    )
    try {
      return { files, ok: true as const, value: await create(files) }
    } catch (error) {
      return { files, ok: false as const, error }
    }
  }
  let outcome = await attempt(cache)
  if (!outcome.ok && outcome.files.some((file) => file.cached)) {
    // A file kept by an earlier load may be the bad one: forget them all.
    await Promise.all(urls.map((url) => cache?.delete(url).catch(() => undefined)))
    outcome = await attempt(undefined)
  }
  if (!outcome.ok) throw outcome.error
  // A full disk only means downloading again next time.
  await Promise.all(
    outcome.files
      .filter((file) => !file.cached)
      .map((file) =>
        cache
          ?.put(file.url, new Response(file.bytes, { headers: { "Content-Type": file.type } }))
          .catch(() => undefined)
      )
  )
  return outcome.value
}

/**
 * Deletes the files of other versions of MediaPipe's WebAssembly that
 * earlier loads kept: those under `prefix` (the default jsDelivr folder,
 * without its version) that aren't under `current`.
 */
export async function removeOtherVersions(
  cache: Cache | undefined,
  prefix: string,
  current: string
) {
  if (!cache) return
  try {
    for (const request of await cache.keys()) {
      if (request.url.startsWith(prefix) && !request.url.startsWith(current)) {
        await cache.delete(request)
      }
    }
  } catch {
    // Nothing to delete, or no storage.
  }
}
