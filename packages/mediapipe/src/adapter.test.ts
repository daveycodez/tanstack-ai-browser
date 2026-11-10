/**
 * What the adapter does around MediaPipe's TextEmbedder, which is stubbed:
 * the options it creates and sets it with, the vectors it returns, and its
 * checks before anything loads.
 */
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { FilesetResolver, TextEmbedder } from "@mediapipe/tasks-text"
import { embed } from "@tanstack/ai"

import { MediaPipeEmbeddingAdapter, mediaPipeEmbedding } from "./index.js"
import { MEDIAPIPE_EMBEDDING_MODELS, MEDIAPIPE_MODEL_META } from "./model-meta.js"
import { MEDIAPIPE_WASM_URL } from "./version.js"

type Embedding = { floatEmbedding?: Array<number>; quantizedEmbedding?: Uint8Array }

const fake = {
  wasmPaths: [] as Array<string>,
  created: [] as Array<{ fileset: unknown; options: unknown }>,
  setOptions: [] as Array<unknown>,
  closed: 0,
  embedding: { floatEmbedding: [0.5, -0.25] } as Embedding,
  /** Holds each setOptions until it resolves. */
  gate: undefined as Promise<void> | undefined,
  /** Called when setOptions starts. */
  onSetOptions: undefined as (() => void) | undefined
}

const stub = <T extends object>(target: T, values: Record<string, unknown>) => Object.assign(target, values)
stub(FilesetResolver, {
  forTextTasks: async (wasmPath: string) => {
    fake.wasmPaths.push(wasmPath)
    return { wasmLoaderPath: `${wasmPath}/loader.js`, wasmBinaryPath: `${wasmPath}/binary.wasm` }
  }
})
stub(TextEmbedder, {
  createFromOptions: async (fileset: unknown, options: unknown) => {
    fake.created.push({ fileset, options })
    let closed = false
    return {
      setOptions: async (options: unknown) => {
        fake.setOptions.push(options)
        fake.onSetOptions?.()
        await fake.gate
      },
      embed: () => {
        if (closed) throw new Error("embed on a closed graph")
        return { embeddings: [fake.embedding] }
      },
      close: () => {
        closed = true
        fake.closed++
      }
    }
  }
})

beforeEach(() => {
  fake.wasmPaths = []
  fake.created = []
  fake.setOptions = []
  fake.closed = 0
  fake.embedding = { floatEmbedding: [0.5, -0.25] }
  fake.gate = undefined
  fake.onSetOptions = undefined
})

test("the factory defaults to Universal Sentence Encoder, as an embedding adapter named mediapipe", () => {
  const adapter = mediaPipeEmbedding()
  assert.ok(adapter instanceof MediaPipeEmbeddingAdapter)
  assert.equal(adapter.kind, "embedding")
  assert.equal(adapter.name, "mediapipe")
  assert.equal(adapter.model, "universal-sentence-encoder")
  assert.deepEqual(MEDIAPIPE_EMBEDDING_MODELS, ["universal-sentence-encoder"])
  assert.equal(MEDIAPIPE_MODEL_META["universal-sentence-encoder"].dimensions, 100)
})

test("by default MediaPipe loads the installed version's WebAssembly and Google's model file", async () => {
  await mediaPipeEmbedding().create()
  assert.deepEqual(fake.wasmPaths, [MEDIAPIPE_WASM_URL])
  assert.deepEqual(fake.created, [
    {
      fileset: { wasmLoaderPath: `${MEDIAPIPE_WASM_URL}/loader.js`, wasmBinaryPath: `${MEDIAPIPE_WASM_URL}/binary.wasm` },
      options: { baseOptions: { modelAssetPath: MEDIAPIPE_MODEL_META["universal-sentence-encoder"].file } }
    }
  ])
})

test("load options go to MediaPipe, and the embedder is created once", async () => {
  const adapter = mediaPipeEmbedding("universal-sentence-encoder", {
    wasmPath: "/mediapipe/wasm",
    modelAssetPath: "/models/use.tflite",
    delegate: "GPU"
  })
  await Promise.all([adapter.create(), embed({ adapter, input: "one", debug: false })])
  assert.deepEqual(fake.wasmPaths, ["/mediapipe/wasm"])
  assert.equal(fake.created.length, 1)
  assert.deepEqual((fake.created[0]?.options as { baseOptions: unknown }).baseOptions, {
    modelAssetPath: "/models/use.tflite",
    delegate: "GPU"
  })
})

test("each call sets l2Normalize and quantize, and returns one vector per input", async () => {
  const adapter = mediaPipeEmbedding()
  const plain = await embed({ adapter, input: ["one", { type: "text", content: "two" }], debug: false })
  assert.deepEqual(plain.embeddings.map((e) => e.vector), [[0.5, -0.25], [0.5, -0.25]])
  fake.embedding = { floatEmbedding: [], quantizedEmbedding: new Uint8Array([1, 255]) }
  const quantized = await embed({
    adapter,
    input: "three",
    dimensions: 100,
    modelOptions: { l2Normalize: true, quantize: true },
    debug: false
  })
  assert.deepEqual(quantized.embeddings[0]?.vector, [1, -1])
  assert.deepEqual(fake.setOptions, [
    { l2Normalize: false, quantize: false },
    { l2Normalize: true, quantize: true }
  ])
})

test("dimensions other than the model's 100 throw before anything loads", async () => {
  await assert.rejects(
    embed({ adapter: mediaPipeEmbedding(), input: "a red guitar", dimensions: 256, debug: false }),
    /returns 100 dimensions and can't return 256/
  )
  assert.equal(fake.created.length, 0)
})

test("image inputs throw: the model is text-only", async () => {
  const image = { type: "image", source: { type: "url", value: "https://example.com/a.png" } }
  await assert.rejects(
    embed({
      adapter: mediaPipeEmbedding(),
      // An untyped caller: the model's input modalities reject this at compile time.
      input: [image] as unknown as Array<string>,
      debug: false
    }),
    /only supports text embedding inputs/
  )
})

test("availability follows the embedder: downloadable, available once created, downloadable after destroy", async () => {
  const adapter = mediaPipeEmbedding()
  assert.equal(await adapter.availability(), "downloadable")
  await adapter.create()
  assert.equal(await adapter.availability(), "available")
  await adapter.destroy()
  assert.equal(fake.closed, 1)
  assert.equal(await adapter.availability(), "downloadable")
})

test("destroy during a call waits for its batch, then closes the embedder; the next call creates it again", async () => {
  let release!: () => void
  fake.gate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (fake.onSetOptions = resolve))
  const adapter = mediaPipeEmbedding()
  const embedding = embed({ adapter, input: "one", debug: false })
  await started
  const destroyed = adapter.destroy()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.closed, 0, "not while its batch runs")
  release()
  assert.deepEqual((await embedding).embeddings[0]?.vector, [0.5, -0.25])
  await destroyed
  assert.equal(fake.closed, 1)
  assert.equal(await adapter.availability(), "downloadable")
  fake.gate = undefined
  await embed({ adapter, input: "two", debug: false })
  assert.equal(fake.created.length, 2)
})
