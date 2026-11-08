/**
 * Downloads a file once and keeps it in Cache Storage, so later loads read it
 * from there, offline too. Where there's no Cache Storage (an insecure
 * context), it's downloaded each time.
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

/** The adapter's cache, or undefined where there's no Cache Storage. */
export async function openCache(): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return undefined
  }
}

/** The bytes of `url`, from `cache` if it has them, else downloaded into it. */
export async function cachedDownload(
  url: string,
  cache: Cache | undefined,
  onProgress?: (progress: DownloadProgress) => void
): Promise<Uint8Array<ArrayBuffer>> {
  const hit = await cache?.match(url).catch(() => undefined)
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer())
    onProgress?.({ cached: true, loadedBytes: bytes.byteLength, totalBytes: bytes.byteLength })
    return bytes
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
  // A full disk only means it downloads again next time.
  await cache
    ?.put(url, new Response(bytes, { headers: { "Content-Type": type } }))
    .catch(() => undefined)
  return bytes
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
