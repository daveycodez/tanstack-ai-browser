import assert from "node:assert/strict"
import { test } from "node:test"

import {
  webgllmImage,
  WEBGLLM_IMAGE_MODEL_META,
  WEBGLLM_IMAGE_MODELS
} from "./image-adapter.js"

const logger = { request: () => undefined, errors: () => undefined } as never
const model = WEBGLLM_IMAGE_MODELS[0]

test("the image adapter is TanStack AI's image kind, named webgllm, for webgllm's image models", () => {
  const adapter = webgllmImage(model)
  assert.equal(adapter.kind, "image")
  assert.equal(adapter.name, "webgllm")
  assert.equal(adapter.model, "cfahlgren1/tessera-small-onnx")
  assert.ok(WEBGLLM_IMAGE_MODEL_META[model].license)
})

test("a model webgllm doesn't run is refused", () => {
  assert.throws(
    () => webgllmImage("someone/else" as never),
    /doesn't know someone\/else/
  )
})

test("image parts and empty prompts are refused before anything loads, and the logger hears of it", async () => {
  const seen: Array<string> = []
  const logging = {
    request: () => undefined,
    errors: (message: string) => seen.push(message)
  } as never
  const adapter = webgllmImage(model)
  await assert.rejects(
    adapter.generateImages({
      model,
      prompt: [
        {
          type: "image",
          source: { type: "url", value: "https://example.com/a.png" }
        }
      ],
      logger: logging
    }),
    /only takes text prompts, not image parts/
  )
  await assert.rejects(
    adapter.generateImages({ model, prompt: "  ", logger }),
    /The prompt is empty/
  )
  assert.equal(seen.length, 1)
})

test("webgllm checks the request before anything loads", async () => {
  // Node has no GPU: a load would fail with an engine error, not this.
  await assert.rejects(
    webgllmImage(model).generateImages({
      model,
      prompt: "duck",
      numberOfImages: 99,
      logger
    }),
    /n must be a whole number from 1 to 8/
  )
})
