/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel. apfel speaks OpenAI's Chat Completions API, so this is TanStack's
 * OpenAI-compatible adapter pointed at it: tool calls and structured output
 * go to apfel as `tools` and `response_format`. It takes `modelOptions` with
 * the OpenRouter adapter's names and sends them with OpenAI's, and adds
 * `availability()` and `create()`, which ask apfel whether it serves the
 * model.
 */
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible"
import type { OpenAICompatibleChatAdapter } from "@tanstack/ai-openai/compatible"

import type { ApfelChatModel } from "./model-meta.js"

export type ApfelConfig = {
  /** apfel's OpenAI-compatible API, up to `/v1`. `http://127.0.0.1:11434/v1` by default. */
  baseURL?: string
  /** Headers sent with every request, such as apfel's bearer token. */
  defaultHeaders?: Record<string, string>
}

/** Per-call `modelOptions`, with the OpenRouter adapter's names. */
export type ApfelTextModelOptions = {
  /** Sent as `max_tokens`. */
  maxCompletionTokens?: number
  temperature?: number
  /** Sent as `top_p`. */
  topP?: number
  seed?: number
}

/** The Prompt API's availability values; apfel's model is "available" or "unavailable". */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** TanStack's OpenAI-compatible adapter for apfel, with apfel's availability. */
export type ApfelTextAdapter = OpenAICompatibleChatAdapter<ApfelChatModel, ApfelTextModelOptions> & {
  /** "available" if apfel answers and serves the model, else "unavailable". */
  availability(signal?: AbortSignal): Promise<Availability>
  /** Resolves to this adapter if apfel serves the model, else rejects. Nothing loads. */
  create(options?: { signal?: AbortSignal }): Promise<ApfelTextAdapter>
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"

/** `modelOptions` with OpenAI's names, as the request takes them. */
function toOpenAI(options: ApfelTextModelOptions | undefined) {
  if (!options) return undefined
  const { maxCompletionTokens, temperature, topP, seed } = options
  return {
    ...(maxCompletionTokens !== undefined && { max_tokens: maxCompletionTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { top_p: topP }),
    ...(seed !== undefined && { seed })
  }
}

/**
 * An adapter for a model apfel serves.
 *
 * @example
 * ```ts
 * const adapter = apfelText("apple-foundationmodel")
 * if ((await adapter.availability()) === "available") {
 *   chat({ adapter, messages, tools })
 * }
 * ```
 */
export function apfelText(model: ApfelChatModel, config: ApfelConfig = {}): ApfelTextAdapter {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const headers = config.defaultHeaders
  const adapter = openaiCompatibleText(model, {
    name: "apfel",
    baseURL,
    // apfel takes any key unless it was started with a token (see defaultHeaders).
    apiKey: "apfel",
    api: "chat-completions",
    ...(headers && { defaultHeaders: headers }),
    // apfel runs on the user's own machine: there's no secret key to expose.
    dangerouslyAllowBrowser: true
  }) as OpenAICompatibleChatAdapter<ApfelChatModel, ApfelTextModelOptions>

  // Each call's modelOptions, renamed for the request.
  const chatStream = adapter.chatStream.bind(adapter)
  adapter.chatStream = (options) => chatStream({ ...options, modelOptions: toOpenAI(options.modelOptions) })
  const structuredOutput = adapter.structuredOutput.bind(adapter)
  adapter.structuredOutput = (options) =>
    structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, modelOptions: toOpenAI(options.chatOptions.modelOptions) }
    })
  if (adapter.structuredOutputStream) {
    const structuredOutputStream = adapter.structuredOutputStream.bind(adapter)
    adapter.structuredOutputStream = (options) =>
      structuredOutputStream({
        ...options,
        chatOptions: { ...options.chatOptions, modelOptions: toOpenAI(options.chatOptions.modelOptions) }
      })
  }

  const availability = async (signal?: AbortSignal): Promise<Availability> => {
    try {
      const timeout = AbortSignal.timeout(10_000)
      const response = await fetch(`${baseURL}/models`, {
        ...(headers && { headers }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      const list = (await response.json()) as { data?: Array<{ id?: string }> }
      return response.ok && list.data?.some((m) => m.id === model) ? "available" : "unavailable"
    } catch {
      return "unavailable"
    }
  }

  const apfel: ApfelTextAdapter = Object.assign(adapter, {
    availability,
    async create({ signal }: { signal?: AbortSignal } = {}) {
      signal?.throwIfAborted()
      const answer = await availability(signal)
      signal?.throwIfAborted()
      if (answer !== "available") {
        throw new Error(`apfel at ${baseURL} didn't answer, or doesn't serve ${model}. Start it with \`apfel --serve --cors\`.`)
      }
      return apfel
    }
  })
  return apfel
}
