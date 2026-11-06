/**
 * A stand-in for the shared WebGLLM instance's methods, so the adapter's
 * tests run without workers or models: loads resolve at once, and each
 * completion streams the chunks the test scripts. (No tests of its own.)
 */
import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionCreateParamsStreaming,
  CompletionTimings,
  FinishReason,
  LoadModelOptions,
  RequestOptions,
  WebGLLMEventMap
} from "webgllm"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import type { TextOptions } from "@tanstack/ai"

import type { WebGllmTextProviderOptions } from "./adapter.js"
import { unloadModel, webgllm } from "./models.js"

export const MODEL = "LiquidAI/LFM3-1.7B-GGUF"

/** What a scripted completion streams: chunks, an Error to throw there, or a pause. */
export type Step = ChatCompletionChunk | Error | { wait: Promise<void> }

export const fake = {
  requests: [] as Array<{ body: ChatCompletionCreateParamsStreaming; options: RequestOptions }>,
  loads: [] as Array<{ model: string; options: LoadModelOptions }>,
  unloads: [] as Array<string | undefined>,
  /** Models the fake holds loaded. */
  loaded: new Set<string>(),
  /** Download size models.retrieve reports. */
  size: 1_000_000_000,
  /** Rejects the next loads with it. */
  loadError: undefined as Error | undefined,
  /** Holds loads until it resolves. */
  loadGate: undefined as Promise<void> | undefined,
  /** Rejects create() itself with it (before any chunk). */
  createError: undefined as Error | undefined,
  /** Set when the adapter stopped reading a stream early. */
  returned: 0,
  /** The steps of each completion, from its request. */
  script: (() => [chunk({ role: "assistant", content: "Hello" }), chunk({}, "stop"), usageChunk()]) as (
    body: ChatCompletionCreateParamsStreaming
  ) => Array<Step>,
  reset() {
    void unloadModel()
    this.requests = []
    this.loads = []
    this.unloads = []
    this.loaded.clear()
    this.size = 1_000_000_000
    this.loadError = undefined
    this.loadGate = undefined
    this.createError = undefined
    this.returned = 0
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
      fake.returned++
      return { value: undefined, done: true }
    }
  }
  return { [Symbol.asyncIterator]: () => iterator }
}

/** Dispatches a lifecycle event on the real instance, as webgllm itself does. */
export function emit<K extends keyof WebGLLMEventMap>(type: K, event: WebGLLMEventMap[K]) {
  ;(webgllm as unknown as { dispatch(type: K, event: WebGLLMEventMap[K]): void }).dispatch(type, event)
}

// Like webgllm's own: "loadstart", then "load", or "error" and "unload" ("failed" / "aborted").
webgllm.loadModel = async (model, options = {}) => {
  fake.loads.push({ model, options })
  emit("loadstart", { model, ...(options.contextLength !== undefined && { contextLength: options.contextLength }) })
  if (fake.loadGate) await fake.loadGate
  if (options.signal?.aborted) {
    emit("unload", { model, reason: "aborted" })
    options.signal.throwIfAborted()
  }
  if (fake.loadError) {
    emit("error", { model, error: fake.loadError })
    emit("unload", { model, reason: "failed" })
    throw fake.loadError
  }
  fake.loaded.add(model)
  emit("load", { model, contextLength: options.contextLength ?? 32_768 })
}
webgllm.unloadModel = async (model) => {
  fake.unloads.push(model)
  for (const name of model === undefined ? [...fake.loaded] : fake.loaded.has(model) ? [model] : []) {
    fake.loaded.delete(name)
    emit("unload", { model: name, reason: "unloaded" })
  }
}
webgllm.models.retrieve = async (model) => ({
  id: model,
  format: "gguf",
  contextLength: 32_768,
  size: fake.size,
  downloaded: true,
  loaded: fake.loaded.has(model),
  supports: { tools: true, thinking: true }
})
webgllm.chat.completions.create = (async (body: ChatCompletionCreateParamsStreaming, options: RequestOptions = {}) => {
  fake.requests.push({ body, options })
  options.signal?.throwIfAborted()
  if (fake.createError) throw fake.createError
  return stream(fake.script(body), options.signal)
}) as typeof webgllm.chat.completions.create

/** A chatStream call's options. */
export function textOptions(
  extra: Partial<TextOptions<WebGllmTextProviderOptions>> = {}
): TextOptions<WebGllmTextProviderOptions> {
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
