/**
 * Which files a model loaded from, so `availability()` can tell a model on
 * the device from one to download without starting a worker, importing
 * Transformers.js or touching the network.
 *
 * After a load succeeds, the worker records the URLs of the model's weights
 * files (Transformers.js's cache keys) in a small Cache Storage entry of its
 * own. `availability()` then checks that each of those URLs is still in
 * Transformers.js's cache, which the browser or the user may have cleared.
 */
import type { WeightsDtype } from "./protocol.js"

/** This package's own cache, beside Transformers.js's. */
const RECORDS = "tanstack-ai-browser-transformers-js"

/** Transformers.js's cache (its `env.cacheKey` default). */
export const TRANSFORMERS_CACHE = "transformers-cache"

const recordUrl = (modelId: string, dtype: WeightsDtype) =>
  `https://tanstack-ai-browser.invalid/transformers-js/${encodeURIComponent(modelId)}/${dtype}`

const cacheStorage = () => (typeof caches === "undefined" ? null : caches)

/**
 * Records `urls` as the files `modelId` loaded with `dtype`, if every one of
 * them is in `cacheName` (so a model loaded from elsewhere isn't recorded).
 */
export async function saveRecord(
  modelId: string,
  dtype: WeightsDtype,
  urls: ReadonlyArray<string>,
  cacheName = TRANSFORMERS_CACHE
) {
  const storage = cacheStorage()
  if (!storage || urls.length === 0) return
  try {
    const files = await storage.open(cacheName)
    for (const url of urls) {
      if (!(await files.match(url))) return
    }
    const records = await storage.open(RECORDS)
    await records.put(
      recordUrl(modelId, dtype),
      new Response(JSON.stringify(urls), { headers: { "Content-Type": "application/json" } })
    )
  } catch {
    // Without a record, availability() says "downloadable": still correct to load.
  }
}

/** Whether `modelId`'s recorded files for `dtype` are all still cached. */
export async function recordedFilesCached(
  modelId: string,
  dtype: WeightsDtype,
  cacheName = TRANSFORMERS_CACHE
) {
  const storage = cacheStorage()
  if (!storage) return false
  try {
    const record = await (await storage.open(RECORDS)).match(recordUrl(modelId, dtype))
    if (!record) return false
    const urls = (await record.json()) as unknown
    if (!Array.isArray(urls) || urls.length === 0) return false
    const files = await storage.open(cacheName)
    for (const url of urls) {
      if (typeof url !== "string" || !(await files.match(url))) return false
    }
    return true
  } catch {
    return false
  }
}
