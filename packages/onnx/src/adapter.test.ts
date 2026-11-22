import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { onnxImage } from "./adapter.js"
import { ONNX_IMAGE_MODELS } from "./model-meta.js"
import { ORT_VERSION } from "./runtime.js"

const logger = {
  request: () => undefined,
  errors: () => undefined
} as never

const model = ONNX_IMAGE_MODELS[0]

test("the adapter is TanStack AI's image kind, named onnx", () => {
  const adapter = onnxImage(model)
  assert.equal(adapter.kind, "image")
  assert.equal(adapter.name, "onnx")
  assert.equal(adapter.model, model)
})

test("an unknown model is refused", () => {
  assert.throws(
    () => onnxImage("someone/else" as never),
    /doesn't know someone\/else/
  )
})

test("numberOfImages is 1 to 8", async () => {
  const adapter = onnxImage(model)
  for (const numberOfImages of [0, 9, 1.5]) {
    await assert.rejects(
      adapter.generateImages({ model, prompt: "duck", numberOfImages, logger }),
      /numberOfImages must be 1 to 8/
    )
  }
})

test("only the model's own size is taken", async () => {
  await assert.rejects(
    onnxImage(model).generateImages({
      model,
      prompt: "duck",
      size: "1024x1024" as never,
      logger
    }),
    /draws 16x16 images, not 1024x1024/
  )
})

test("image parts in the prompt are refused, and an empty prompt", async () => {
  const adapter = onnxImage(model)
  await assert.rejects(
    adapter.generateImages({
      model,
      prompt: [
        {
          type: "image",
          source: { type: "url", value: "https://example.com/a.png" }
        }
      ],
      logger
    }),
    /only takes text prompts, not image parts/
  )
  await assert.rejects(
    adapter.generateImages({ model, prompt: "   ", logger }),
    /The prompt is empty/
  )
})

test("errors go to the logger", async () => {
  const seen: Array<string> = []
  const logging = {
    request: () => undefined,
    errors: (message: string) => seen.push(message)
  } as never
  await assert.rejects(
    onnxImage(model).generateImages({ model, prompt: "", logger: logging })
  )
  assert.equal(seen.length, 1)
})

test("a model with no stored files is downloadable", async () => {
  // Node has no Cache Storage: nothing is stored.
  assert.equal(await onnxImage(model).availability(), "downloadable")
})

test("invalid steps, guidance and seeds are refused before anything loads", async () => {
  const adapter = onnxImage(model)
  for (const steps of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1001
  ]) {
    await assert.rejects(
      adapter.generateImages({
        model,
        prompt: "duck",
        modelOptions: { steps },
        logger
      }),
      /steps must be a whole number from 1 to 1000/
    )
  }
  for (const guidanceScale of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      adapter.generateImages({
        model,
        prompt: "duck",
        modelOptions: { guidanceScale },
        logger
      }),
      /guidanceScale must be a finite number/
    )
  }
  await assert.rejects(
    adapter.generateImages({
      model,
      prompt: "duck",
      modelOptions: { seed: Number.NaN },
      logger
    }),
    /seed must be a finite number/
  )
})

test("adapters with other session or WebGPU options don't share sessions", () => {
  const key = (adapter: ReturnType<typeof onnxImage>) =>
    (adapter as unknown as { key: string }).key
  class FakeDevice {}
  const device = new FakeDevice() as GPUDevice
  const quiet = { sessionOptions: { logSeverityLevel: 3 as const } }
  assert.equal(key(onnxImage(model)), key(onnxImage(model, {})))
  assert.equal(
    key(onnxImage(model, quiet)),
    key(onnxImage(model, { sessionOptions: { logSeverityLevel: 3 } }))
  )
  assert.notEqual(key(onnxImage(model)), key(onnxImage(model, quiet)))
  assert.notEqual(
    key(onnxImage(model)),
    key(onnxImage(model, { webgpuOptions: { preferredLayout: "NHWC" } }))
  )
  // Objects JSON can't stand for are told apart by identity.
  assert.equal(
    key(onnxImage(model, { webgpuOptions: { device } })),
    key(onnxImage(model, { webgpuOptions: { device } }))
  )
  assert.notEqual(
    key(onnxImage(model, { webgpuOptions: { device } })),
    key(
      onnxImage(model, {
        webgpuOptions: { device: new FakeDevice() as GPUDevice }
      })
    )
  )
})

test("a load whose caller has already given up doesn't start", async () => {
  await assert.rejects(
    onnxImage(model).create({ signal: AbortSignal.abort() }),
    { name: "AbortError" }
  )
})

test("the WebAssembly files load at the installed onnxruntime-web version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { dependencies: Record<string, string> }
  assert.equal(manifest.dependencies["onnxruntime-web"], ORT_VERSION)
})
