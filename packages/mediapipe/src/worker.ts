/**
 * The embedder's worker: MediaPipe's TextEmbedder, the official
 * `@mediapipe/tasks-text` package unmodified, through its public API. It
 * runs here so embedding doesn't hold up the page. One worker loads one
 * embedder; the page ends the worker to free it.
 *
 * MediaPipe's WebAssembly and the model's file are downloaded once and kept
 * in Cache Storage, then given to MediaPipe from memory: the WebAssembly as
 * blob URLs in its fileset, the model as `modelAssetBuffer`.
 */
import { FilesetResolver, TextEmbedder } from "@mediapipe/tasks-text"

import { cachedDownload, openCache, removeOtherVersions } from "./download.js"
import type { EmbedRequest, LoadRequest, WorkerRequest, WorkerResponse } from "./protocol.js"
import { toVector } from "./vectors.js"
import { MEDIAPIPE_CDN_PREFIX, MEDIAPIPE_WASM_URL } from "./version.js"

const ctx = globalThis as unknown as {
  postMessage: (message: WorkerResponse, transfer?: Array<Transferable>) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** A blob URL of `bytes`, so MediaPipe loads a file from memory. */
const blobUrl = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
  URL.createObjectURL(new Blob([bytes], { type }))

let embedder: Promise<TextEmbedder> | undefined

/** The embedder options it was last set to (MediaPipe's defaults first). */
let current = { l2Normalize: false, quantize: false }

async function load({ wasmPath, modelUrl, delegate }: LoadRequest) {
  const cache = await openCache()
  // MediaPipe's names for its files. The ES module build: this is a module
  // worker, where MediaPipe imports its loader instead of importScripts().
  const fileset = await FilesetResolver.forTextTasks(wasmPath.replace(/\/$/, ""), true)
  const [loader, wasm, model] = await Promise.all([
    cachedDownload(fileset.wasmLoaderPath, cache),
    cachedDownload(fileset.wasmBinaryPath, cache),
    cachedDownload(modelUrl, cache, (progress) =>
      ctx.postMessage({ type: "progress", ...progress })
    )
  ])
  if (wasmPath.startsWith(MEDIAPIPE_CDN_PREFIX)) {
    void removeOtherVersions(cache, MEDIAPIPE_CDN_PREFIX, MEDIAPIPE_WASM_URL)
  }
  const loaderUrl = blobUrl(loader, "text/javascript")
  const wasmUrl = blobUrl(wasm, "application/wasm")
  try {
    return await TextEmbedder.createFromOptions(
      { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
      {
        baseOptions: { modelAssetBuffer: model, ...(delegate && { delegate }) },
        ...current
      }
    )
  } finally {
    URL.revokeObjectURL(loaderUrl)
    URL.revokeObjectURL(wasmUrl)
  }
}

/** Requests run one at a time, so an option change never lands mid-batch. */
let queue: Promise<unknown> = Promise.resolve()

async function embed({ id, texts, l2Normalize, quantize }: EmbedRequest) {
  try {
    if (!embedder) throw new Error("No model is loaded.")
    const textEmbedder = await embedder
    if (l2Normalize !== current.l2Normalize || quantize !== current.quantize) {
      await textEmbedder.setOptions({ l2Normalize, quantize })
      current = { l2Normalize, quantize }
    }
    const vectors = texts.map((text) => toVector(textEmbedder.embed(text).embeddings[0]))
    ctx.postMessage(
      { type: "embedded", id, vectors },
      vectors.map((vector) => vector.buffer)
    )
  } catch (error) {
    ctx.postMessage({ type: "embed-error", id, message: errorText(error) })
  }
}

ctx.onmessage = ({ data }) => {
  if (data.type === "load") {
    embedder = load(data)
    embedder.then(
      () => ctx.postMessage({ type: "ready" }),
      (error: unknown) => ctx.postMessage({ type: "load-error", message: errorText(error) })
    )
  } else {
    queue = queue.then(() => embed(data))
  }
}
