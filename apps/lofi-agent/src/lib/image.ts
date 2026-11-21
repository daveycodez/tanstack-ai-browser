/**
 * The built-in image tool: the chat model calls it with a short description,
 * and the image model picked in Settings draws it, in the page, through
 * TanStack AI's `generateImage()` with that model's provider's adapter
 * (webgllm's or the `onnx` package's), in the chat model's place (it
 * unloads meanwhile). Its result is a line for the model and the images,
 * which only the chat shows (the adapters pass a tool result's text to the
 * model, not its images).
 */
import { generateImage, toolDefinition } from "@tanstack/ai"
import type { ContentPart } from "@tanstack/ai"
import { ONNX_MODEL_META, onnxImage } from "@tanstack-ai-browser/onnx"
import type { OnnxImageModel } from "@tanstack-ai-browser/onnx"
import {
  webgllmImage,
  WEBGLLM_IMAGE_MODEL_META
} from "@tanstack-ai-browser/webgllm"
import type { WebGllmImageModel } from "@tanstack-ai-browser/webgllm"

import { whileUnloaded } from "#/chat/models"
import type { ModelId } from "#/chat/models"
import { oneAtATime } from "#/lib/one-at-a-time"
import { setting } from "#/lib/settings"
import { createStore } from "#/lib/store"

export const IMAGE_TOOL = "generate_image"

/** Images one call draws: one, so the image model's memory stays inside an iPhone tab's. */
export const IMAGES_PER_CALL = 1

/** A model's name as its Hugging Face repository shows it (the part after the owner), as the chat models are named. */
const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1)

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

/**
 * The image models Settings offers, by provider (A to Z), each by its id
 * (`<provider>:<repository>`): WebGLLM runs Tessera on its own engines
 * (WebGPU, else WebGL 2), ONNX on ONNX Runtime (WebGPU, else the CPU).
 */
export const IMAGE_MODELS = [
  ...(
    [
      "cfahlgren1/tessera-small-onnx"
    ] as const satisfies ReadonlyArray<OnnxImageModel>
  ).map((repo) => ({
    id: `onnx:${repo}` as const,
    provider: "ONNX",
    name: repoName(repo),
    download: ONNX_MODEL_META[repo].download,
    license: ONNX_MODEL_META[repo].license,
    adapter: () => onnxImage(repo, { onDownloadProgress })
  })),
  ...(
    [
      "cfahlgren1/tessera-small-onnx"
    ] as const satisfies ReadonlyArray<WebGllmImageModel>
  ).map((repo) => ({
    id: `webgllm:${repo}` as const,
    provider: "WebGLLM",
    name: repoName(repo),
    download: megabytes(
      Object.values(WEBGLLM_IMAGE_MODEL_META[repo].files).reduce(
        (sum, file) => sum + file.bytes,
        0
      )
    ),
    license: WEBGLLM_IMAGE_MODEL_META[repo].license,
    adapter: () => webgllmImage(repo, { onDownloadProgress })
  }))
]

export type ImageModelEntry = (typeof IMAGE_MODELS)[number]

/** No image model: the tool is off. */
export const NO_IMAGE_MODEL = "none"

export type ImageModelChoice = ImageModelEntry["id"] | typeof NO_IMAGE_MODEL

/** The image model the tool draws with, or none (the tool is off): WebGLLM's Tessera until the user picks. */
export const imageModelSetting = setting(
  "imageModel",
  "webgllm:cfahlgren1/tessera-small-onnx" as ImageModelChoice
)

/** An image model's entry, by its id. */
export const imageModelEntry = (id: string): ImageModelEntry | undefined =>
  IMAGE_MODELS.find((m) => m.id === id)

/** The picked image model, if there is one (a saved id no longer offered is none). */
export const pickedImageModel = (): ImageModelEntry | undefined =>
  imageModelEntry(imageModelSetting.get())

/** The image model's download while it loads, 0 to 1 (undefined when it isn't downloading), for the tool's widget. */
export const imageDownload = createStore<number | undefined>(undefined)

function onDownloadProgress(progress: number) {
  imageDownload.set(progress < 1 ? progress : undefined)
}

const adapters = new Map<string, ReturnType<ImageModelEntry["adapter"]>>()
const adapterFor = (entry: ImageModelEntry) => {
  let adapter = adapters.get(entry.id)
  if (!adapter) {
    adapter = entry.adapter()
    adapters.set(entry.id, adapter)
  }
  return adapter
}

/**
 * Runs one image call's whole swap (unload the chat model, draw, unload the
 * image model, load the chat model again) after the one before has ended.
 * TanStack AI runs a reply's tool calls in parallel, and two image calls
 * share the image adapter: without this, the first to finish would unload
 * the image model (ending the other's drawing) and reload the chat model
 * while the other still drew. A call stopped while it waits never starts
 * its swap, so it can't unload the chat model the one before restored.
 */
const swapQueue = oneAtATime()

/**
 * The result's line for the model: the image is in front of the person, and
 * its part is a sentence about it. Told what not to do instead, asked for "a
 * short sentence", or told nothing, LFM3 adds an image of its own (a made-up
 * link or file name) after "Here's your …:" in 1 reply in 10 to every reply;
 * asked for a sentence about it, in none of 30.
 */
const resultLine = (prompt: string) =>
  `The person can see the image of "${prompt}" now. Reply with a sentence about it.`

const imageToolDefinition = toolDefinition({
  name: IMAGE_TOOL,
  description:
    "Draws a pixel-art image from a short description and shows it to the person.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw, in a few words." }
    },
    required: ["prompt"]
  }
})

/**
 * The image tool for a run answered by `chatModel`. The chat model and the
 * image model never sit in memory together: the chat model unloads, the
 * image model loads and draws, then unloads, and the chat model loads again
 * for the rest of the reply (chat/models.ts's `whileUnloaded`).
 */
export const imageToolFor = (chatModel: ModelId) =>
  imageToolDefinition.server(
    async (args, context): Promise<Array<ContentPart>> => {
      const prompt =
        typeof (args as { prompt?: unknown }).prompt === "string"
          ? (args as { prompt: string }).prompt.trim()
          : ""
      if (!prompt) throw new Error("A prompt is needed.")
      const model = pickedImageModel()
      if (!model) throw new Error("No image model is picked in Settings.")
      const signal = context?.abortSignal
      const adapter = adapterFor(model)
      const result = await swapQueue(
        () =>
          whileUnloaded(
            chatModel,
            async () => {
              try {
                return await generateImage({
                  adapter: adapter as ReturnType<typeof onnxImage>,
                  prompt,
                  numberOfImages: IMAGES_PER_CALL,
                  threadId: crypto.randomUUID(),
                  ...(signal && { abortSignal: signal })
                })
              } finally {
                imageDownload.set(undefined)
                await adapter.destroy()
              }
            },
            signal
          ),
        signal
      )
      return [
        { type: "text", content: resultLine(prompt) },
        ...result.images.flatMap((image): Array<ContentPart> =>
          image.b64Json
            ? [
                {
                  type: "image",
                  source: {
                    type: "data",
                    value: image.b64Json,
                    mimeType: "image/png"
                  }
                }
              ]
            : []
        )
      ]
    }
  )

/** A tool result's images as data URLs, if it has any. */
export function imagesOf(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value.flatMap((part: unknown) => {
    const source =
      (
        part as {
          type?: unknown
          source?: { type?: unknown; value?: unknown; mimeType?: unknown }
        }
      ).type === "image"
        ? (
            part as {
              source?: { type?: unknown; value?: unknown; mimeType?: unknown }
            }
          ).source
        : undefined
    if (source?.type !== "data" || typeof source.value !== "string") return []
    return [
      `data:${typeof source.mimeType === "string" ? source.mimeType : "image/png"};base64,${source.value}`
    ]
  })
}
