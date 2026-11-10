/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel. apfel speaks OpenAI's Chat Completions API, so this is TanStack's
 * OpenAI-compatible adapter pointed at it: tool calls and structured output
 * go to apfel as `tools` and `response_format`, and `modelOptions` as given.
 * It adds `availability()` and `create()`, which ask apfel whether it serves
 * the model.
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

/** Per-call `modelOptions`: the request fields apfel takes, with OpenAI's names, sent as given. */
export type ApfelTextModelOptions = {
  /** Most tokens to generate. */
  max_tokens?: number
  temperature?: number
  top_p?: number
  seed?: number
}

/** The Prompt API's availability values; apfel's model is "available" or "unavailable". */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** TanStack's OpenAI-compatible adapter for apfel, with apfel's availability. */
export type ApfelTextAdapter = OpenAICompatibleChatAdapter<ApfelModel, ApfelTextModelOptions> & {
  /** "available" if apfel answers and serves the model, else "unavailable". */
  availability(signal?: AbortSignal): Promise<Availability>
  /** Resolves to this adapter if apfel serves the model, else rejects. Nothing loads. */
  create(options?: { signal?: AbortSignal }): Promise<ApfelTextAdapter>
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"

/** A model apfel serves: Apple's ("apple-foundationmodel", the default), or any other name. */
export type ApfelModel = ApfelChatModel | (string & {})

/**
 * An adapter for a model apfel serves: Apple's on-device model by default.
 *
 * @example
 * ```ts
 * const adapter = apfelText()
 * if ((await adapter.availability()) === "available") {
 *   chat({ adapter, messages, tools })
 * }
 * ```
 */
export function apfelText(config?: ApfelConfig): ApfelTextAdapter
export function apfelText(model: ApfelModel, config?: ApfelConfig): ApfelTextAdapter
export function apfelText(modelOrConfig?: ApfelModel | ApfelConfig, maybeConfig: ApfelConfig = {}): ApfelTextAdapter {
  const model = typeof modelOrConfig === "string" ? modelOrConfig : "apple-foundationmodel"
  const config = typeof modelOrConfig === "string" ? maybeConfig : (modelOrConfig ?? {})
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
  }) as OpenAICompatibleChatAdapter<ApfelModel, ApfelTextModelOptions>

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
