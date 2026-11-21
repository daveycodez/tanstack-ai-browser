/**
 * Downloaded model files, kept in the page's Cache Storage under the URL
 * they were downloaded from, which names the commit. A file is stored whole
 * or not at all: a cache entry only appears once its body is written.
 */

/** The parts of the page's Cache Storage and network the store uses (tests give their own). */
export type StorageEnvironment = {
  caches: Pick<CacheStorage, "open">
  fetch: (input: string, init?: RequestInit) => Promise<Response>
}

/** The cache's name in the page's Cache Storage. */
export const MODEL_CACHE = "tanstack-ai-browser-onnx"

const environment = (): StorageEnvironment | undefined =>
  typeof caches === "undefined"
    ? undefined
    : { caches, fetch: (input, init) => fetch(input, init) }

const coded = (message: string, code: string, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { code })

/**
 * Whether every one of these files is stored. Cache Storage this page can't
 * open (a SecurityError in some private windows) counts as nothing stored,
 * so loads go on to download without caching (fileBytes).
 */
export async function allStored(
  urls: ReadonlyArray<string>,
  env = environment()
): Promise<boolean> {
  if (!env) return false
  try {
    const cache = await env.caches.open(MODEL_CACHE)
    for (const url of urls) if (!(await cache.match(url))) return false
    return true
  } catch {
    return false
  }
}

/**
 * A file's bytes: from the cache, else downloaded into it first, with the
 * bytes downloaded so far reported as they arrive. Without Cache Storage
 * (some private windows) the file downloads every time. An aborted or failed
 * download stores nothing.
 */
export async function fileBytes(
  url: string,
  options: { onBytes?: (bytes: number) => void; signal?: AbortSignal } = {},
  env = environment()
): Promise<ArrayBuffer> {
  const cache = env
    ? await env.caches.open(MODEL_CACHE).catch(() => undefined)
    : undefined
  const hit = await cache?.match(url)
  if (hit) return hit.arrayBuffer()
  const { onBytes, signal } = options
  const response = await (env?.fetch ?? fetch)(
    url,
    signal ? { signal } : undefined
  )
  if (!response.ok || !response.body) {
    throw coded(
      `${url} didn't download (HTTP ${response.status})`,
      "download-failed"
    )
  }
  let loaded = 0
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength
        onBytes?.(loaded)
        controller.enqueue(chunk)
      }
    })
  )
  if (!cache) return new Response(counted).arrayBuffer()
  try {
    await cache.put(url, new Response(counted))
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    const full =
      error instanceof DOMException && error.name === "QuotaExceededError"
    throw coded(
      full
        ? "There's no room to store the model on this device"
        : `${url} couldn't be stored (${error instanceof Error ? error.message : String(error)})`,
      full ? "storage-full" : "download-failed",
      error
    )
  }
  const stored = await cache.match(url)
  if (!stored) throw coded(`${url} wasn't stored`, "download-failed")
  return stored.arrayBuffer()
}

/** Removes these files from the cache. Returns whether any was stored. */
export async function removeFiles(
  urls: ReadonlyArray<string>,
  env = environment()
): Promise<boolean> {
  if (!env) return false
  const cache = await env.caches.open(MODEL_CACHE).catch(() => undefined)
  if (!cache) return false
  let removed = false
  for (const url of urls) removed = (await cache.delete(url)) || removed
  return removed
}
