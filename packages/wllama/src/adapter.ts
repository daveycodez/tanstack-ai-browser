/**
 * A TanStack AI text adapter for GGUF models that run in the browser with
 * wllama (llama.cpp in WebAssembly). wllama answers llama.cpp's
 * OpenAI-compatible Chat Completions API in the page, so this is TanStack's
 * Chat Completions adapter with the loaded model as its client: messages,
 * tools, structured output and the stream (text, thinking, tool calls) are
 * TanStack's, and llama.cpp writes the prompt with the model's chat template
 * and reads its thinking and tool calls back. This file adds what's wllama's
 * own: loading the model with the adapter's settings, the chat template's
 * thinking switch, the model card's sampling, and audio parts for the
 * models that read them.
 */
import type { ReasoningRequest, TextOptions } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { OpenAIBaseChatCompletionsTextAdapter } from "@tanstack/openai-base"
import type { OpenAIClientLike } from "@tanstack/openai-base"
import type { WllamaCompat } from "@wllama/wllama/esm/index.js"

import { llamaAudio } from "./audio.js"
import { availability, loadModel, unloadModel } from "./client.js"
import type { Availability, DownloadProgressCallback, LoadSettings } from "./client.js"
import { listed, modelMeta } from "./catalog.js"
import type { Sampling, WllamaChatModel, WllamaModel, WllamaModelReasoningByName } from "./catalog.js"

export type WllamaConfig = {
  /**
   * Most tokens a chat may hold, prompt and reply together: the model's
   * whole context window by default (its GGUF's training context), never
   * more. llama.cpp reserves the attention cache for all of it when the
   * model loads (LFM3: ~12 KB a token, so 3 GB for its 262,144), so set
   * less where memory is short: 8,192 on an iPhone. Changing it loads the
   * model again.
   */
  contextLength?: number
  /**
   * Where wllama's WebAssembly file is served. By default, the installed
   * `@wllama/wllama`'s own file on jsDelivr, at its version; serve
   * `@wllama/wllama/esm/wasm/wllama.wasm` with the site and pass its URL to
   * host it yourself.
   */
  wasmUrl?: string
  /**
   * Where wllama's compat build (for Safari: `@wllama/wllama-compat`'s
   * `wasm/wllama.wasm` and `wasm/wllama.js`) is served, passed to
   * `Wllama.setCompat`. By default, wllama's: the same version on jsDelivr.
   */
  compat?: WllamaCompat
  /** CPU threads. wllama's default otherwise: half the cores. */
  threads?: number
  /**
   * `false` to run on the CPU only. By default wllama runs on WebGPU where
   * it can, and on the CPU elsewhere.
   */
  gpu?: boolean
  /** wllama's and llama.cpp's logs, in the console. */
  debug?: boolean
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Per-call `modelOptions`: llama.cpp's own request fields, sent as given
 * (wllama answers with llama.cpp's OpenAI-compatible server code), over the
 * model card's sampling. These are the common ones; llama.cpp's others go
 * through too.
 */
export type WllamaTextModelOptions = {
  /** Most tokens to generate, thinking included. llama.cpp's default otherwise: up to the context limit. */
  max_tokens?: number
  /** Randomness of sampling: 0 is greedy. */
  temperature?: number
  /** Nucleus sampling: the likeliest tokens up to this probability, in (0, 1]. */
  top_p?: number
  /** Sampling from the likeliest `top_k` tokens only (0: all of them). */
  top_k?: number
  /** Drops tokens less likely than this share of the likeliest one's odds. */
  min_p?: number
  /** Penalizes tokens already in the chat (1: off). */
  repeat_penalty?: number
  /** Lowers the odds of tokens by how often they've appeared. */
  frequency_penalty?: number
  /** Lowers the odds of tokens that have appeared at all. */
  presence_penalty?: number
  /** Seeds the sampler, for the same samples from the same request. */
  seed?: number
  /** Where to stop: the reply ends before the first of these it would write. */
  stop?: string | Array<string>
  /** Adds to the odds of tokens, by token id. */
  logit_bias?: Record<string, number>
  /**
   * False constrains the model to one tool call. True or left out: as many
   * as the model writes, when its chat template supports several.
   */
  parallel_tool_calls?: boolean
  /** The chat template's own variables; `chat({ reasoning })` sets its `enable_thinking`. */
  chat_template_kwargs?: Record<string, unknown>
}

/** A model's reasoning levels: a listed model's, none for a listed one that doesn't reason, else the switch. */
type ResolveReasoning<TModel extends string> = TModel extends keyof WllamaModelReasoningByName
  ? WllamaModelReasoningByName[TModel]
  : TModel extends WllamaChatModel
    ? never
    : { levels: "off" | "high"; budget: true }

/** The switch for a model the catalog doesn't list: the chat template's `enable_thinking`. */
const UNLISTED_REASONING = { levels: { off: "false", high: "true" }, budget: true } as const

/** A model's reasoning levels: the catalog's, or the switch for one it doesn't list. */
const reasoningOf = (model: WllamaModel) => (listed(model) ? modelMeta(model).reasoning : UNLISTED_REASONING)

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

/** The base adapter's conversion of a message part to a Chat Completions one. */
type ConvertContentPart = OpenAIBaseChatCompletionsTextAdapter<string>["convertContentPart"]

/** A Chat Completions request, as the base adapter writes it. */
type CreateParams = Parameters<OpenAIClientLike["chat"]["completions"]["create"]>[0]

/**
 * The chat template's `enable_thinking` for a request, through llama.cpp's
 * `chat_template_kwargs`, and a thinking budget: left out when the model has
 * no levels or the request doesn't ask, so the template's default applies.
 */
function thinkingKwargs(
  request: ReasoningRequest | undefined,
  model: WllamaModel,
  kwargs: Record<string, unknown> | undefined
): Record<string, unknown> {
  const value = resolveReasoning(request, reasoningOf(model))?.value
  if (value === undefined) return {}
  const thinking = value === "true"
  const budget = request?.budgetTokens
  return {
    chat_template_kwargs: { ...kwargs, enable_thinking: thinking },
    ...(thinking && budget !== undefined && { reasoning_budget_tokens: budget })
  }
}

/**
 * The card's sampling for a request: its thinking settings while the chat
 * template thinks (asked for, or a model that always thinks), else its
 * own. None for a model the catalog doesn't list: llama.cpp's defaults.
 */
function cardSampling(request: ReasoningRequest | undefined, model: WllamaModel): Partial<Sampling> {
  if (!listed(model)) return {}
  const meta = modelMeta(model)
  const value = resolveReasoning(request, meta.reasoning)?.value
  const thinking = value !== undefined ? value === "true" : !!meta.reasoning && !("off" in meta.reasoning.levels)
  return (thinking && meta.thinkingSampling) || meta.sampling
}

/** What a URL holds: a data URL's bytes, or those the page fetches. */
const bytesAt = async (url: string, signal?: AbortSignal) => (await fetch(url, { ...(signal && { signal }) })).arrayBuffer()

/** A Chat Completions part that names its media by URL. */
type MediaPart = { type?: string; image_url?: { url: string }; audio_url?: { url: string } }

/**
 * A request's messages with each image and audio clip as its bytes: wllama
 * reads them as `{ type: "image", data }` and `{ type: "audio", data }`,
 * where the request has an `image_url` or an `audio_url` (a data URL here,
 * or one the page can fetch). Audio llama.cpp can't decode goes as WAV.
 */
async function withMediaBytes(messages: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!Array.isArray(messages)) return messages
  return Promise.all(
    messages.map(async (message: { content?: unknown }) => {
      if (!Array.isArray(message.content)) return message
      const content = await Promise.all(
        message.content.map(async (part: MediaPart) => {
          if (part.type === "image_url" && part.image_url) {
            return { type: "image", data: await bytesAt(part.image_url.url, signal) }
          }
          if (part.type === "audio_url" && part.audio_url) {
            return { type: "audio", data: await llamaAudio(await bytesAt(part.audio_url.url, signal)) }
          }
          return part
        })
      )
      return { ...message, content }
    })
  )
}

/**
 * The model as an OpenAI client: each request loads it with the adapter's
 * settings (at once when it's loaded with them) and goes to wllama's
 * `createChatCompletion`.
 */
function clientFor(model: WllamaModel, settings: LoadSettings, onDownloadProgress?: DownloadProgressCallback): OpenAIClientLike {
  const create = async (body: Record<string, unknown>, options?: { signal?: AbortSignal | null }) => {
    const signal = options?.signal ?? undefined
    const wllama = await loadModel(model, settings, { ...(onDownloadProgress && { onDownloadProgress }), ...(signal && { signal }) })
    const messages = await withMediaBytes(body.messages, signal)
    return wllama.createChatCompletion({ ...body, messages, ...(signal && { abortSignal: signal }) } as never)
  }
  return { baseURL: "wllama:", chat: { completions: { create } } } as unknown as OpenAIClientLike
}

/** The settings a model loads with, from the adapter's config. */
const loadSettings = ({ contextLength, wasmUrl, compat, threads, gpu, debug }: WllamaConfig): LoadSettings => ({
  ...(contextLength !== undefined && { contextLength }),
  ...(wasmUrl && { wasmUrl }),
  ...(compat && { compat }),
  ...(threads && { threads }),
  ...(gpu !== undefined && { gpu }),
  ...(debug && { debug })
})

export class WllamaTextAdapter<TModel extends WllamaModel> extends OpenAIBaseChatCompletionsTextAdapter<
  TModel,
  WllamaTextModelOptions,
  ReadonlyArray<"text" | "image" | "audio">,
  MetadataByModality,
  ReadonlyArray<string>,
  ResolveReasoning<TModel>
> {
  override readonly name = "wllama"
  override readonly api = "wllama"
  /** Text, and images or audio for a listed model whose projector reads them. */
  override readonly inputModalities: ReadonlyArray<"text" | "image" | "audio">

  private readonly settings: LoadSettings
  private readonly onDownloadProgress: DownloadProgressCallback | undefined

  constructor(config: WllamaConfig, model: TModel) {
    const settings = loadSettings(config)
    super(model, "wllama", clientFor(model, settings, config.onDownloadProgress), { strictFallbackWarning: false })
    this.settings = settings
    this.onDownloadProgress = config.onDownloadProgress
    this.inputModalities = listed(model) ? modelMeta(model).supports.input : ["text"]
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "available" once it's in wllama's storage (or loaded), "downloading"
   * while this page downloads it, else "downloadable"; "unavailable" where
   * wllama can't run.
   */
  availability(): Promise<Availability> {
    return availability(this.model)
  }

  /**
   * Downloads the model if it isn't stored and loads it with this adapter's
   * settings, with the download's progress, 0 to 1, then 1 once it's ready.
   * Resolves to this adapter; rejects if it can't load (fine to leave
   * unawaited). `chat()` doesn't need it: its first call loads the model.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const own = this.onDownloadProgress
    const theirs = options.onDownloadProgress
    const ready = loadModel(this.model, this.settings, {
      onDownloadProgress: (progress) => {
        own?.(progress)
        theirs?.(progress)
      },
      ...(options.signal && { signal: options.signal })
    }).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Unloads the model, freeing its memory. It stays in wllama's storage. */
  async destroy(): Promise<void> {
    await unloadModel(this.model)
  }

  /** The request, with `modelOptions` as given over the model card's sampling, and the chat template's thinking switch. */
  protected override mapOptionsToRequest(options: TextOptions): CreateParams & { stream: true } {
    const modelOptions = options.modelOptions as WllamaTextModelOptions | undefined
    const settings = {
      ...cardSampling(options.reasoning, this.model),
      ...modelOptions,
      ...(options.promptCache?.retention === "none" && { cache_prompt: false })
    }
    const request = super.mapOptionsToRequest({ ...options, modelOptions: settings, reasoning: undefined })
    return Object.assign(request, thinkingKwargs(options.reasoning, this.model, modelOptions?.chat_template_kwargs))
  }

  /** llama.cpp streams thinking as `reasoning_content`. */
  protected override extractReasoning(chunk: unknown) {
    const text = (chunk as { choices?: Array<{ delta?: { reasoning_content?: string } }> }).choices?.[0]?.delta?.reasoning_content
    return text ? { text } : undefined
  }

  /**
   * An audio part by its URL, as an image goes: Chat Completions takes
   * audio only as base64 in two formats, and the client reads the bytes of
   * either kind from a URL (a data URL for base64).
   */
  protected override convertContentPart(part: Parameters<ConvertContentPart>[0]): ReturnType<ConvertContentPart> {
    if (part.type !== "audio") return super.convertContentPart(part)
    const { source } = part
    if (source.type === "file") {
      throw new Error("wllama takes audio as data or URLs, not as uploaded files.")
    }
    const url =
      source.type === "data" && !source.value.startsWith("data:")
        ? `data:${source.mimeType || "application/octet-stream"};base64,${source.value}`
        : source.value
    return { type: "audio_url", audio_url: { url } } as unknown as ReturnType<ConvertContentPart>
  }

  /** Schemas as given: llama.cpp's grammar takes any JSON Schema, without OpenAI's strict-mode rewrite. */
  protected override makeStructuredOutputCompatible(schema: Record<string, any>) {
    return schema
  }
}

/**
 * A TanStack AI text adapter for a GGUF model that wllama runs in the
 * browser.
 *
 * @example
 * ```ts
 * chat({ adapter: wllamaText("unsloth/Qwen3.5-2B-GGUF"), messages, threadId })
 * ```
 */
export function wllamaText<TModel extends WllamaModel>(
  model: TModel,
  config: WllamaConfig = {}
): WllamaTextAdapter<TModel> {
  return new WllamaTextAdapter(config, model)
}
