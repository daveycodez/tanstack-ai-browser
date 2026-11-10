/**
 * A TanStack AI text adapter for WebLLM: MLC's models on WebGPU, in a Web
 * Worker. WebLLM answers OpenAI's Chat Completions API in the page, so this
 * is TanStack's Chat Completions adapter with WebLLM's engine as its client:
 * messages, tools, structured output and the stream (text, tool calls) are
 * TanStack's, and WebLLM writes the prompt with the model's conversation
 * template. This file adds what's WebLLM's own: loading the model with the
 * adapter's settings, its sampling options' names, its shape for JSON
 * Schema answers, and stopping a generation with its interrupt (its
 * requests take no AbortSignal).
 */
import type { TextOptions, Tool } from "@tanstack/ai"
import { OpenAIBaseChatCompletionsTextAdapter } from "@tanstack/openai-base"
import type { OpenAIClientLike } from "@tanstack/openai-base"
import type { AppConfig, ChatCompletionRequest, ResponseFormat } from "@mlc-ai/web-llm"

import { availability, loadModel, unloadModel } from "./client.js"
import type { Availability, DownloadProgressCallback, LoadSettings } from "./client.js"
import type { WebLlmChatModel } from "./catalog.js"
import { toolCallFence, toolCallReader, toolResultFence, toolResultLine, toolSystemPrompt } from "./tools.js"
import type { ParsedToolCall } from "./tools.js"

export type WebLlmConfig = {
  /**
   * Most tokens a chat may hold, prompt and reply together: WebLLM's
   * `context_window_size`. The model's own by default (its catalog entry's,
   * 4,096 for most). Changing it loads the model again.
   */
  contextLength?: number
  /**
   * WebLLM's model list, for a model its catalog doesn't have (a
   * `ModelRecord` with the model's weights and compiled library).
   * WebLLM's `prebuiltAppConfig` by default.
   */
  appConfig?: AppConfig
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time
   * with progress, see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/**
 * Per-call `modelOptions`, named as OpenRouter's adapter names them, so an
 * app can swap this adapter for `@tanstack/ai-openrouter`'s unchanged;
 * mapped to WebLLM's request fields. Sampling left out comes from the
 * model's own config in WebLLM's catalog.
 */
export type WebLlmTextModelOptions = {
  /** Most tokens to generate (WebLLM's `max_tokens`). Otherwise up to the context window. */
  maxCompletionTokens?: number
  /** Randomness of sampling: 0 is greedy. */
  temperature?: number
  /** Nucleus sampling: the likeliest tokens up to this probability, in (0, 1]. */
  topP?: number
  /** Lowers the odds of tokens by how often they've appeared. */
  frequencyPenalty?: number
  /** Lowers the odds of tokens that have appeared at all. */
  presencePenalty?: number
  /** WebLLM: penalizes tokens already in the chat (`repetition_penalty`; 1: off). */
  repetitionPenalty?: number
  /** Seeds the sampler, for the same samples from the same request (an integer). */
  seed?: number
  /** Where to stop: the reply ends before the first of these it would write. */
  stop?: string | Array<string>
  /** Adds to the odds of tokens, by token id: -100 to 100. */
  logitBias?: Record<string, number>
}

/** A model WebLLM's catalog lists, or any `model_id` of the adapter's `appConfig`. */
export type WebLlmModel = WebLlmChatModel | (string & {})

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

/** A Chat Completions request, as the base adapter writes it. */
type CreateParams = Parameters<OpenAIClientLike["chat"]["completions"]["create"]>[0]

/** `modelOptions` with WebLLM's names. */
function toRequestOptions(o: WebLlmTextModelOptions | undefined): Record<string, unknown> {
  const fields = {
    max_tokens: o?.maxCompletionTokens,
    temperature: o?.temperature,
    top_p: o?.topP,
    frequency_penalty: o?.frequencyPenalty,
    presence_penalty: o?.presencePenalty,
    repetition_penalty: o?.repetitionPenalty,
    seed: o?.seed,
    stop: o?.stop,
    logit_bias: o?.logitBias
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

/** OpenAI's `response_format`, in WebLLM's shape: a JSON Schema goes as `json_object` with the schema as text. */
function toResponseFormat(format: unknown): ResponseFormat {
  const given = format as { type?: string; json_schema?: { schema?: unknown } }
  if (given.type !== "json_schema") return format as ResponseFormat
  return { type: "json_object", schema: JSON.stringify(given.json_schema?.schema) }
}

/**
 * WebLLM's engine as an OpenAI client: each request loads the model with
 * the adapter's settings (at once when it's loaded with them) and goes to
 * WebLLM's `chat.completions.create`. WebLLM takes no AbortSignal: the
 * caller's signal stops the generation with the engine's `interruptGenerate`.
 */
/** Marks a request whose tools are in its system prompt: the client reads calls out of its reply. */
const PROMPT_TOOLS = Symbol("promptTools")

/** A Chat Completions message, as the base adapter writes it. */
type RequestMessage = {
  role: string
  content?: unknown
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** A message's text: a string, or its text parts joined. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : ""

/**
 * The conversation with tools by prompt: the tools in the system prompt,
 * earlier calls as the model writes them, and a step's results in one user
 * message (WebLLM takes `tool` messages only for its Hermes models).
 */
function withPromptTools(messages: Array<RequestMessage>, tools: ReadonlyArray<Tool>): Array<RequestMessage> {
  const names = new Map<string, string>()
  const out: Array<RequestMessage> = []
  let results: Array<string> | undefined
  for (const message of messages) {
    if (message.role === "tool") {
      const id = message.tool_call_id ?? ""
      const line = toolResultLine(id, names.get(id) ?? "tool", textOf(message.content))
      if (!results) {
        results = []
        out.push({ role: "user" })
      }
      results.push(line)
      out[out.length - 1] = { role: "user", content: toolResultFence(results) }
      continue
    }
    results = undefined
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) names.set(call.id, call.function.name)
      const content = [textOf(message.content), toolCallFence(message.tool_calls)].filter(Boolean).join("\n")
      out.push({ role: "assistant", content })
    } else out.push(message)
  }
  const system = out.find((message) => message.role === "system")
  if (system) system.content = toolSystemPrompt(textOf(system.content), tools)
  else out.unshift({ role: "system", content: toolSystemPrompt("", tools) })
  return out
}

type Chunk = { choices?: Array<{ index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: unknown }

/**
 * A streamed reply with its tool call read out of the text: the text
 * around it as content, then the call as an OpenAI `tool_calls` delta, which
 * ends the reply (`interrupt` stops the generation; later text is dropped).
 */
async function* withToolCalls(stream: AsyncIterable<Chunk>, interrupt: () => void): AsyncIterable<Chunk> {
  const reader = toolCallReader()
  const choice = (chunk: Chunk, delta: Record<string, unknown>, finish: string | null = null): Chunk => ({
    ...chunk,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  for await (const chunk of stream) {
    if (reader.call) {
      // Only the usage that ends the stream.
      if (chunk.usage) yield { ...chunk, choices: [] }
      continue
    }
    const first = chunk.choices?.[0]
    const text = typeof first?.delta?.content === "string" ? first.delta.content : ""
    if (!text && !first?.finish_reason) {
      yield chunk
      continue
    }
    if (text) {
      const shown = reader.push(text)
      if (shown) yield choice(chunk, { ...first?.delta, content: shown })
      // (Set by push above.)
      const call = reader.call as ParsedToolCall | undefined
      if (call) {
        interrupt()
        const toolCall = { index: 0, id: `call_${Date.now().toString(36)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }
        yield choice(chunk, { tool_calls: [toolCall] })
        yield choice(chunk, {}, "tool_calls")
        continue
      }
    }
    if (first?.finish_reason) {
      const rest = reader.end()
      if (rest) yield choice(chunk, { content: rest })
      yield choice(chunk, {}, first.finish_reason)
    }
  }
}

function clientFor(model: WebLlmModel, settings: LoadSettings, onDownloadProgress?: DownloadProgressCallback): OpenAIClientLike {
  const create = async (body: Record<string, unknown>, options?: { signal?: AbortSignal | null }) => {
    const signal = options?.signal ?? undefined
    const engine = await loadModel(model, settings, { ...(onDownloadProgress && { onDownloadProgress }), ...(signal && { signal }) })
    const promptTools = PROMPT_TOOLS in body
    const fields: Record<string | symbol, unknown> = { ...body }
    delete fields[PROMPT_TOOLS]
    const request = {
      ...fields,
      ...(body.response_format !== undefined && { response_format: toResponseFormat(body.response_format) })
    } as unknown as ChatCompletionRequest
    const interrupt = () => engine.interruptGenerate()
    const read = (stream: unknown) => (promptTools ? withToolCalls(stream as AsyncIterable<Chunk>, interrupt) : stream)
    if (!signal) {
      const result = await engine.chat.completions.create(request)
      return request.stream ? read(result) : result
    }
    signal.throwIfAborted()
    signal.addEventListener("abort", interrupt, { once: true })
    const release = () => signal.removeEventListener("abort", interrupt)
    let result: Awaited<ReturnType<typeof engine.chat.completions.create>>
    try {
      result = await engine.chat.completions.create(request)
    } catch (error) {
      release()
      throw error
    }
    if (!request.stream) {
      release()
      return result
    }
    const stream = read(result) as AsyncIterable<unknown>
    return (async function* () {
      try {
        yield* stream
      } finally {
        release()
      }
    })()
  }
  return { baseURL: "web-llm:", chat: { completions: { create } } } as unknown as OpenAIClientLike
}

/** The settings a model loads with, from the adapter's config. */
const loadSettings = ({ contextLength, appConfig }: WebLlmConfig): LoadSettings => ({
  ...(contextLength !== undefined && { chatOptions: { context_window_size: contextLength } }),
  ...(appConfig && { appConfig })
})

export class WebLlmTextAdapter<TModel extends WebLlmModel> extends OpenAIBaseChatCompletionsTextAdapter<
  TModel,
  WebLlmTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>
> {
  override readonly name = "web-llm"
  override readonly api = "web-llm"
  override readonly inputModalities = ["text"] as const

  private readonly settings: LoadSettings
  private readonly onDownloadProgress: DownloadProgressCallback | undefined

  constructor(config: WebLlmConfig, model: TModel) {
    const settings = loadSettings(config)
    super(model, "web-llm", clientFor(model, settings, config.onDownloadProgress), { strictFallbackWarning: false })
    this.settings = settings
    this.onDownloadProgress = config.onDownloadProgress
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" without WebGPU, "downloading" while this page downloads
   * it, "available" when it's loaded or in WebLLM's cache
   * (`hasModelInCache`), else "downloadable".
   */
  availability(): Promise<Availability> {
    return availability(this.model, this.settings.appConfig)
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

  /** Unloads the model, freeing its GPU memory. It stays in WebLLM's cache. */
  async destroy(): Promise<void> {
    await unloadModel(this.model)
  }

  /** The request, with WebLLM's option names. */
  /** The request, with WebLLM's option names, and tools by prompt (see tools.ts). */
  protected override mapOptionsToRequest(options: TextOptions): CreateParams & { stream: true } {
    const modelOptions = options.modelOptions as WebLlmTextModelOptions | undefined
    const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
    const request = super.mapOptionsToRequest({ ...options, tools: [], modelOptions: toRequestOptions(modelOptions) })
    if (tools.length === 0) return request
    const messages = withPromptTools(request.messages as unknown as Array<RequestMessage>, tools)
    return Object.assign(request, { messages, [PROMPT_TOOLS]: true }) as typeof request
  }

  /** Schemas as given: WebLLM's grammar takes any JSON Schema, without OpenAI's strict-mode rewrite. */
  protected override makeStructuredOutputCompatible(schema: Record<string, any>) {
    return schema
  }
}

/**
 * A TanStack AI text adapter for a model that WebLLM runs in the browser,
 * on WebGPU.
 *
 * @example
 * ```ts
 * chat({ adapter: webLlmText("Qwen3-1.7B-q4f16_1-MLC"), messages, threadId })
 * ```
 */
export function webLlmText<TModel extends WebLlmModel>(model: TModel, config: WebLlmConfig = {}): WebLlmTextAdapter<TModel> {
  return new WebLlmTextAdapter(config, model)
}
