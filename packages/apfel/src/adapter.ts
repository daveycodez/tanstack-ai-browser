/**
 * A TanStack AI text adapter for Apple's on-device Foundation Model, served
 * by apfel. apfel speaks OpenAI's Chat Completions API, so this is TanStack's
 * OpenAI-compatible adapter pointed at it: tool calls and structured output
 * go to apfel as `tools` and `response_format` (their schemas as given, not
 * in OpenAI's strict form), image parts as `image_url`
 * parts, and `modelOptions` as given. It adds `availability()` and
 * `create()`, which ask apfel whether it serves the model, and thinking:
 * with `reasoning: "high"`, a step drafts working notes before its reply,
 * and a structured answer before its JSON (`reasoning.ts`).
 */
import type { TextOptions } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible"
import type { OpenAICompatibleChatAdapter } from "@tanstack/ai-openai/compatible"

import { APFEL_MODEL_META, APFEL_MODEL_REASONING } from "./model-meta.js"
import type { ApfelChatModel, ApfelModelReasoningByName } from "./model-meta.js"
import { startsTurn, thinkingAnswer, thinkingAnswerResult, thinkingStep } from "./reasoning.js"
import type { TurnNotes } from "./reasoning.js"

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

/** TanStack's OpenAI-compatible adapter, as it's made for apfel. */
type CompatibleAdapter = OpenAICompatibleChatAdapter<ApfelModel, ApfelTextModelOptions>

/** TanStack's OpenAI-compatible adapter for apfel, with apfel's availability and the adapter's reasoning levels. */
export type ApfelTextAdapter = Omit<CompatibleAdapter, "~types"> & {
  "~types": Omit<CompatibleAdapter["~types"], "reasoning"> & { reasoning: ApfelModelReasoningByName[ApfelChatModel] }
  /** Text and images for Apple's model; not known for another model. */
  readonly inputModalities: ReadonlyArray<"text" | "image"> | undefined
  /** "available" if apfel answers and serves the model, else "unavailable". */
  availability(signal?: AbortSignal): Promise<Availability>
  /** Resolves to this adapter if apfel serves the model, else rejects. Nothing loads. */
  create(options?: { signal?: AbortSignal }): Promise<ApfelTextAdapter>
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"

/**
 * The tools as given: OpenAI's strict mode (TanStack's default for
 * OpenAI-compatible APIs) makes every optional field required and nullable,
 * and apfel lists the tools to the model from these schemas.
 */
const toolsAsGiven = ({ tools }: TextOptions) =>
  tools && {
    tools: tools.map(({ name, description, inputSchema }) => ({
      type: "function" as const,
      function: { name, description, parameters: inputSchema ?? { type: "object", properties: {} } }
    }))
  }

/**
 * A step's thinking, for `reasoning: "high"` (any level of thinking is the
 * adapter's one, whichever model apfel serves): its token budget, if it has
 * one. Undefined for a step that doesn't think: reasoning off or none, or a
 * budget of no tokens.
 */
function thinkingOf(options: TextOptions) {
  const reasoning = resolveReasoning(options.reasoning, APFEL_MODEL_REASONING["apple-foundationmodel"])
  if (reasoning?.level !== "high") return undefined
  if (reasoning.budgetTokens !== undefined && reasoning.budgetTokens <= 0) return undefined
  return { budget: reasoning.budgetTokens }
}

/** The OpenAI base's request methods, overridden on the instance (TanStack's factory returns its class). */
type RequestMapping = {
  mapOptionsToRequest(options: TextOptions): Record<string, unknown>
  makeStructuredOutputCompatibleWithMap(schema: Record<string, unknown>): { schema: Record<string, unknown>; nullWideningMap: unknown }
}

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
  }) as CompatibleAdapter
  // Tools and structured output's schema as given, not in OpenAI's strict form.
  const mapping = adapter as unknown as RequestMapping
  const mapOptionsToRequest = mapping.mapOptionsToRequest.bind(adapter)
  mapping.mapOptionsToRequest = (options) => Object.assign(mapOptionsToRequest(options), toolsAsGiven(options))
  mapping.makeStructuredOutputCompatibleWithMap = (schema) => ({ schema, nullWideningMap: undefined })
  // With reasoning, a step is two requests: working notes, streamed as reasoning, then the reply.
  const step = adapter.chatStream.bind(adapter)
  const turns: TurnNotes = new Map()
  adapter.chatStream = (options) => {
    const thinking = thinkingOf(options)
    if (!thinking) return step(options)
    // chat() sends a structured answer's schema with the chat request (`outputSchema`: apfel takes a schema and tools
    // together). Without tools, that request is the answer to the user's message, and its notes are about the answer alone.
    const answering = options.outputSchema !== undefined && !options.tools?.length && startsTurn(options.messages)
    return answering ? thinkingAnswer(step, options, thinking.budget, step) : thinkingStep(step, options, thinking.budget, turns)
  }
  // Structured output's own requests think first too, when they answer a user's message (the notes are about it):
  // `structuredOutputStream()` with the notes streamed as reasoning, `structuredOutput()` without them.
  const answer = adapter.structuredOutput.bind(adapter)
  const answerStream = adapter.structuredOutputStream.bind(adapter)
  adapter.structuredOutputStream = (options) => {
    const thinking = startsTurn(options.chatOptions.messages) && thinkingOf(options.chatOptions)
    return thinking ? thinkingAnswer(step, options.chatOptions, thinking.budget, (chatOptions) => answerStream({ ...options, chatOptions })) : answerStream(options)
  }
  adapter.structuredOutput = (options) => {
    const thinking = startsTurn(options.chatOptions.messages) && thinkingOf(options.chatOptions)
    return thinking ? thinkingAnswerResult(step, options.chatOptions, thinking.budget, (chatOptions) => answer({ ...options, chatOptions })) : answer(options)
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

  const apfel: ApfelTextAdapter = Object.assign(adapter as Omit<CompatibleAdapter, "~types"> & Pick<ApfelTextAdapter, "~types">, {
    inputModalities: Object.hasOwn(APFEL_MODEL_META, model) ? APFEL_MODEL_META[model as ApfelChatModel].supports.input : undefined,
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
