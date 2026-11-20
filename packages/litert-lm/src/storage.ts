/**
 * Downloaded models, kept in the page's Cache Storage: LiteRT-LM's web
 * runtime (0.19) streams a model from its URL on every load and stores
 * nothing itself. A model is stored whole or not at all (a cache entry only
 * appears once its body is written), under the URL it was downloaded from,
 * which for a Hugging Face model names the commit: a later version of the
 * repository is a different entry.
 *
 * Beside each model is what its name resolved to (the file's URL and size),
 * so a stored model loads again without asking the Hub, offline too.
 */

/** Where a model's file is, as LiteRT-LM resolves it. */
export type ModelFile = {
  /** The file's URL (for a Hugging Face model, at the commit it resolved to). */
  url: string
  /** The file's size in bytes, where known. */
  size?: number
  sha256?: string
}

/** The parts of the page's Cache Storage and network the store uses (tests give their own). */
export type StorageEnvironment = {
  caches: Pick<CacheStorage, "open">
  fetch: (input: string, init?: RequestInit) => Promise<Response>
}

/** The cache's name in the page's Cache Storage. */
export const MODEL_CACHE = "tanstack-ai-browser-litert-lm"

/** The entry that holds what a model's name resolved to. (A URL no server answers: it's only a key.) */
const recordUrl = (model: string) => `https://litert-lm.invalid/resolved/${encodeURIComponent(model)}`

const environment = (): StorageEnvironment | undefined =>
  typeof caches === "undefined" ? undefined : { caches, fetch: (input, init) => fetch(input, init) }

const coded = (message: string, code: string, cause?: unknown) => Object.assign(new Error(message, { cause }), { code })

/** The model's file as it was resolved when it was stored, if the file is still stored. */
export async function storedFile(model: string, env = environment()): Promise<ModelFile | undefined> {
  if (!env) return undefined
  const cache = await env.caches.open(MODEL_CACHE)
  const record = await cache.match(recordUrl(model))
  if (!record) return undefined
  const file = (await record.json()) as ModelFile
  return (await cache.match(file.url)) ? file : undefined
}

/** A stored file's bytes, as a stream. Undefined if it isn't stored. */
export async function readFile(file: ModelFile, env = environment()): Promise<ReadableStream<Uint8Array> | undefined> {
  if (!env) return undefined
  const response = await (await env.caches.open(MODEL_CACHE)).match(file.url)
  return response?.body ?? undefined
}

/**
 * Downloads a model's file into the cache, reporting its progress, 0 to 1
 * (bytes so far of the file's size; nothing where the size isn't known).
 * `accessToken` is sent to the file's host and never stored. An aborted or
 * failed download stores nothing.
 */
export async function downloadFile(
  model: string,
  file: ModelFile,
  options: { onProgress?: (progress: number) => void; signal?: AbortSignal; accessToken?: string } = {},
  env = environment()
): Promise<void> {
  if (!env) throw coded("This page has no Cache Storage to keep a model in", "unavailable")
  const { onProgress, signal, accessToken } = options
  const response = await env.fetch(file.url, {
    ...(signal && { signal }),
    ...(accessToken && { headers: { Authorization: `Bearer ${accessToken}` } })
  })
  if (!response.ok || !response.body) {
    const gated = response.status === 401 || response.status === 403
    throw coded(
      `${model}'s file didn't download (HTTP ${response.status})${gated ? ": the model may be gated, and need an access token" : ""}`,
      gated ? "unauthorized" : "download-failed"
    )
  }
  const total = Number(response.headers.get("Content-Length")) || file.size || 0
  let loaded = 0
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength
        // Under 1 until the file is stored.
        if (total > 0) onProgress?.(Math.min(loaded / total, 0.999))
        controller.enqueue(chunk)
      }
    })
  )
  const cache = await env.caches.open(MODEL_CACHE)
  try {
    await cache.put(file.url, new Response(counted, { headers: total > 0 ? { "Content-Length": String(total) } : {} }))
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    const full = error instanceof DOMException && error.name === "QuotaExceededError"
    throw coded(
      full ? `There's no room to store ${model} on this device` : `${model}'s file couldn't be stored (${error instanceof Error ? error.message : String(error)})`,
      full ? "storage-full" : "download-failed",
      error
    )
  }
  await cache.put(recordUrl(model), new Response(JSON.stringify({ url: file.url, ...(total > 0 && { size: total }), ...(file.sha256 && { sha256: file.sha256 }) })))
}

/** Removes a model's stored file. Returns whether it was stored. */
export async function removeFile(model: string, env = environment()): Promise<boolean> {
  if (!env) return false
  const cache = await env.caches.open(MODEL_CACHE)
  const record = await cache.match(recordUrl(model))
  if (!record) return false
  const file = (await record.json()) as ModelFile
  await cache.delete(recordUrl(model))
  return cache.delete(file.url)
}
