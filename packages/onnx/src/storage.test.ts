import assert from "node:assert/strict"
import { test } from "node:test"

import { allStored, fileBytes, removeFiles } from "./storage.js"
import type { StorageEnvironment } from "./storage.js"

/** Cache Storage the page can't open, as in some private windows. */
const noCache: StorageEnvironment = {
  caches: {
    open: () =>
      Promise.reject(
        new DOMException("The operation is insecure.", "SecurityError")
      )
  },
  fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
}

test("Cache Storage that can't be opened counts as nothing stored", async () => {
  assert.equal(await allStored(["https://example.com/a"], noCache), false)
  assert.equal(await removeFiles(["https://example.com/a"], noCache), false)
})

test("without Cache Storage a file still downloads, uncached", async () => {
  const seen: Array<number> = []
  const bytes = await fileBytes(
    "https://example.com/a",
    { onBytes: (n) => seen.push(n) },
    noCache
  )
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3])
  assert.deepEqual(seen, [3])
})
