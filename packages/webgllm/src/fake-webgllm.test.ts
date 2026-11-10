/**
 * A stand-in for the shared WebGLLM instance's methods, so the adapter's
 * tests run without workers or models: loads resolve at once (after the
 * scripted download progress), and each completion streams the chunks the
 * test scripts. (No tests of its own.)
 */
import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionCreateParamsStreaming,
  CompletionTimings,
  FinishReason,
  LoadModelOptions,
  LoadProgress,
  RequestOptions,
  WebGLLMEventMap
} from "webgllm"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import type { TextOptions } from "@tanstack/ai"

import { webgllm } from "./adapter.js"
import type { WebGllmTextModelOptions } from "./adapter.js"

export const MODEL = "LiquidAI/LFM3-1.7B-GGUF"

/** What a scripted completion streams: chunks, an Error to throw there, or a pause. */
export type Step = ChatCompletionChunk | Error | { wait: Promise<void> }

export const fake = {
  requests: [] as Array<{ body: ChatCompletionCreateParamsStreaming; options: RequestOptions }>,
  loads: [] as Array<{ model: string; options: LoadModelOptions }>,
  unloads: [] as Array<string | undefined>,
  /** Models the fake holds loaded, with the context each was loaded for. */
  loaded: new Map<string, number | undefined>(),
  /** Models whose files the fake's storage holds (models.downloaded). */
  stored: new Set<string>(),
  /** Download progress each load reports before it finishes. */
  progress: [] as Array<LoadProgress>,
  /** Rejects the next loads with it. */
  loadError: undefined as Error | undefined,
  /** Holds loads until it resolves. */
  loadGate: undefined as Promise<void> | undefined,
  /** The steps of each completion, from its request. */
  script: (() => [chunk({ role: "assistant", content: "Hello" }), chunk({}, "stop"), usageChunk()]) as (
    body: ChatCompletionCreateParamsStreaming
  ) => Array<Step>,
  reset() {
    this.requests = []
    this.loads = []
    this.unloads = []
    this.loaded.clear()
    this.stored.clear()
    this.progress = []
    this.loadError = undefined
    this.loadGate = undefined
    this.script = () => [chunk({ role: "assistant", content: "Hello" }), chunk({}, "stop"), usageChunk()]
  }
}

export function chunk(delta: ChatCompletionChunkDelta, finish: FinishReason | null = null): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }]
  }
}

export const TIMINGS: CompletionTimings = {
  first_token_ms: 12,
  prompt_ms: 10,
  decode_ms: 40,
  prompt_tokens_per_second: 900,
  decode_tokens_per_second: 25
}

export function usageChunk(
  usage: { prompt?: number; completion?: number; cached?: number; reasoning?: number } = {}
): ChatCompletionChunk {
  const prompt = usage.prompt ?? 9
  const completion = usage.completion ?? 2
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
      completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 }
    },
    timings: TIMINGS
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const abortError = () => new DOMException("The operation was aborted.", "AbortError")

function stream(steps: Array<Step>, signal: AbortSignal | undefined): AsyncIterable<ChatCompletionChunk> {
  let i = 0
  let done = false
  const iterator: AsyncIterator<ChatCompletionChunk> = {
    async next() {
      for (;;) {
        await tick()
        if (signal?.aborted) throw abortError()
        if (done || i >= steps.length) return { value: undefined, done: true }
        const step = steps[i++]!
        if (step instanceof Error) throw step
        if ("wait" in step) {
          await step.wait
          continue
        }
        return { value: step, done: false }
      }
    },
    async return() {
      done = true
      return { value: undefined, done: true }
    }
  }
  return { [Symbol.asyncIterator]: () => iterator }
}

/** Dispatches a lifecycle event on the real instance, as webgllm itself does. */
export function emit<K extends keyof WebGLLMEventMap>(type: K, event: WebGLLMEventMap[K]) {
  ;(webgllm as unknown as { dispatch(type: K, event: WebGLLMEventMap[K]): void }).dispatch(type, event)
}

const abortable = (promise: Promise<void>, signal?: AbortSignal) =>
  signal
    ? Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      ])
    : promise

// Like webgllm's loadModel: at once when loaded for that context; otherwise
// the scripted download progress (with webgllm's events), then "load".
webgllm.loadModel = async (model, options = {}) => {
  options.signal?.throwIfAborted()
  fake.loads.push({ model, options })
  if (fake.loaded.has(model) && fake.loaded.get(model) === options.contextLength) return
  for (const progress of fake.progress) {
    emit("progress", progress)
    options.onProgress?.(progress)
  }
  await abortable(fake.loadGate ?? Promise.resolve(), options.signal)
  if (fake.loadError) {
    emit("error", { model, error: fake.loadError })
    throw fake.loadError
  }
  fake.loaded.set(model, options.contextLength)
  emit("load", { model, contextLength: options.contextLength ?? 32_768 })
}
webgllm.unloadModel = async (model) => {
  fake.unloads.push(model)
  for (const name of model === undefined ? [...fake.loaded.keys()] : [model]) {
    if (fake.loaded.delete(name)) emit("unload", { model: name, reason: "unloaded" })
  }
}
webgllm.models.downloaded = async (model) => fake.loaded.has(model) || fake.stored.has(model)
webgllm.chat.completions.create = (async (body: ChatCompletionCreateParamsStreaming, options: RequestOptions = {}) => {
  fake.requests.push({ body, options })
  options.signal?.throwIfAborted()
  if (body.stream !== true) return completion(body, fake.script(body))
  return stream(fake.script(body), options.signal)
}) as typeof webgllm.chat.completions.create

/** A request without `stream`: the scripted chunks as one completion, as webgllm answers it. */
async function completion(body: { model: string }, steps: Array<Step>) {
  let content = ""
  let reasoning = ""
  let finish: FinishReason | null = null
  let usage: ChatCompletionChunk["usage"]
  for (const step of steps) {
    if (step instanceof Error) throw step
    if ("wait" in step) {
      await step.wait
      continue
    }
    const choice = step.choices[0]
    content += choice?.delta.content ?? ""
    reasoning += choice?.delta.reasoning_content ?? ""
    finish = choice?.finish_reason ?? finish
    usage = step.usage ?? usage
  }
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(reasoning && { reasoning_content: reasoning }) },
        finish_reason: finish ?? "stop"
      }
    ],
    ...(usage && { usage })
  }
}

/** A chatStream call's options. */
export function textOptions(
  extra: Partial<TextOptions<WebGllmTextModelOptions>> = {}
): TextOptions<WebGllmTextModelOptions> {
  return {
    logger: resolveDebugOption(false),
    threadId: "webgllm-test",
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    ...extra
  }
}

/** Every event a stream yields. */
export async function collect<T>(stream: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const event of stream) out.push(event)
  return out
}

/** The last request's body. */
export const lastBody = () => {
  const request = fake.requests.at(-1)
  if (!request) throw new Error("No request was sent.")
  return request.body
}
