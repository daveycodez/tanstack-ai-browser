/**
 * A TanStack AI text adapter for GGUF models that run in the browser on the
 * CPU, with wllama (llama.cpp in WebAssembly). Hand it to `chat()` like any
 * hosted model's adapter: `chat()` runs tools and the agent loop, and each
 * `chatStream` call here is one chat completion from llama.cpp's
 * OpenAI-compatible API, streamed back as AG-UI events. llama.cpp writes
 * the prompt with the model's chat template and reads its thinking and
 * tool calls back.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type {
  AdapterYieldChunk,
  ModelMessage,
  ReasoningRequest,
  TextOptions,
  TokenUsage,
  Tool
} from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type {
  StructuredOutputOptions,
  StructuredOutputResult
} from "@tanstack/ai/adapters"
import type {
  ChatCompletionMessage,
  ChatCompletionTool,
  ResultTimings,
  WllamaCompat
} from "@wllama/wllama/esm/index.js"

import {
  availability,
  completeChat,
  configureRuntime,
  contextError,
  loadModel,
  loadedContext,
  waitForModel,
  setContextLength,
  setKeepLoaded,
  streamChat,
  unloadModel
} from "./client.js"
import type { Availability, ChatRequest, DownloadProgressCallback } from "./client.js"
import { modelMeta } from "./catalog.js"
import type {
  Sampling,
  WllamaModelReasoningByName,
  WllamaChatModel
} from "./catalog.js"

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
   * Keeps the model loaded when another runtime (Transformers.js, WebGL)
   * loads one past the page's memory budget (see `setMemoryBudget`); by
   * default the least recently used model is unloaded to make room.
   * Applies once the adapter uses the model (`create()` or a call); left
   * out, the model keeps what another adapter of it set.
   */
  keepLoaded?: boolean
  /**
   * Where wllama's WebAssembly file is served. By default, the installed
   * `@wllama/wllama`'s own file on jsDelivr, at its version; serve
   * `@wllama/wllama/esm/wasm/wllama.wasm` with the site and pass its URL to
   * host it yourself. Applies to every model.
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
 * Per-call `modelOptions`, named as OpenRouter's adapter names them, so an
 * app can swap this adapter for `@tanstack/ai-openrouter`'s unchanged;
 * mapped to llama.cpp's own settings. Sampling left out comes from the
 * model card.
 */
export type WllamaTextModelOptions = {
  /** Most tokens to generate, thinking included. llama.cpp's default otherwise: up to the context limit. */
  maxCompletionTokens?: number
  /** Randomness of sampling: 0 is greedy. */
  temperature?: number
  /** Nucleus sampling: the likeliest tokens up to this probability, in (0, 1]. */
  topP?: number
  /** Lowers the odds of tokens by how often they've appeared (llama.cpp's `frequency_penalty`). */
  frequencyPenalty?: number
  /** Lowers the odds of tokens that have appeared at all (llama.cpp's `presence_penalty`). */
  presencePenalty?: number
  /** Seeds the sampler, for the same samples from the same request. */
  seed?: number
  /** Where to stop: the reply ends before the first of these it would write. */
  stop?: string | Array<string>
  /** Sampling from the likeliest `topK` tokens only (0: all of them). */
  topK?: number
  /** Drops tokens less likely than this share of the likeliest one's odds (llama.cpp's `min_p`). */
  minP?: number
  /** Penalizes tokens already in the chat (llama.cpp's `repeat_penalty`; 1: off). */
  repetitionPenalty?: number
  /**
   * False keeps a reply to one tool call (llama.cpp's `parallel_tool_calls`,
   * which constrains the model to a single call). True or left out: as many
   * as the model writes, when its chat template supports several.
   */
  parallelToolCalls?: boolean
}

/**
 * Timings of one model call, in milliseconds, in `RUN_FINISHED`'s
 * `usage.providerUsageDetails`.
 */
export type WllamaProviderUsageDetails = {
  /** From the request to the first generated token, reading the prompt included. */
  firstTokenMs?: number
  /** Reading the part of the prompt that wasn't cached. */
  promptMs?: number
  /** Generating. */
  decodeMs?: number
  /** Tokens generated over `decodeMs`. */
  decodeTokens?: number
}

/** The reasoning levels of a model, for `chat({ reasoning })`; `never` for one that doesn't reason. */
type ResolveReasoning<TModel extends string> =
  TModel extends keyof WllamaModelReasoningByName
    ? WllamaModelReasoningByName[TModel]
    : never

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

function contentText(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return (content ?? [])
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("")
}

/** A tool call's text content, or the error a failed tool gave. */
function toolResultText(m: ModelMessage) {
  const text = contentText(m.content)
  if (m.error) return `Error: ${m.error}`
  return text && text !== "null" ? text : "The tool returned nothing."
}

/** The conversation as OpenAI-style chat messages, the system prompt first. */
function toMessages(
  systemPrompts: TextOptions["systemPrompts"],
  messages: Array<ModelMessage>,
  extraSystem?: string
): Array<ChatCompletionMessage> {
  const system = normalizeSystemPrompts(systemPrompts)
    .map((p) => p.content)
    .concat(extraSystem ?? [])
    .join("\n\n")
  const out: Array<ChatCompletionMessage> = system
    ? [{ role: "system", content: system }]
    : []
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: toolResultText(m)
      })
    } else if (m.role === "assistant") {
      const thinking = m.thinking?.map((t) => t.content).join("")
      out.push({
        role: "assistant",
        content: contentText(m.content),
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.function.name, arguments: c.function.arguments }
          }))
        }),
        // llama.cpp hands it to the chat template, which keeps or drops it.
        ...(thinking && { reasoning_content: thinking })
      })
    } else {
      out.push({ role: m.role, content: contentText(m.content) })
    }
  }
  return out
}

/** Tools in OpenAI's function format. */
function toTools(tools: Array<Tool> | undefined): Array<ChatCompletionTool> {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema ?? {
        type: "object",
        properties: {}
      }) as ChatCompletionTool["function"]["parameters"]
    }
  }))
}

/** A model call's counts as TanStack AI usage, its timings as provider details. */
function usageOf(
  timings: ResultTimings | undefined,
  firstTokenMs: number | null
): TokenUsage | undefined {
  if (!timings) return undefined
  const promptTokens = timings.prompt_n + timings.cache_n
  const usage = buildBaseUsage<WllamaProviderUsageDetails>({
    promptTokens,
    completionTokens: timings.predicted_n,
    totalTokens: promptTokens + timings.predicted_n
  })
  if (timings.cache_n > 0) {
    usage.promptTokensDetails = { cachedTokens: timings.cache_n }
  }
  usage.providerUsageDetails = {
    ...(firstTokenMs !== null && { firstTokenMs }),
    promptMs: timings.prompt_ms,
    ...(timings.predicted_n > 0 && {
      decodeMs: timings.predicted_ms,
      decodeTokens: timings.predicted_n
    })
  }
  return usage
}

/**
 * The chat template's `enable_thinking` for a request, through llama.cpp's
 * `chat_template_kwargs`: left out when the model has no levels or the
 * request doesn't ask, so the template's default applies.
 */
function thinkingKwargs(
  request: ReasoningRequest | undefined,
  model: WllamaChatModel
): Partial<ChatRequest> {
  const budget = request?.budgetTokens
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  }
  const capability = modelMeta(model).reasoning
  const resolved = resolveReasoning(request, capability)
  const value = resolved?.value
  if (value === undefined) {
    if (budget !== undefined) throw new Error(`${model} does not support a thinking token budget.`)
    return {}
  }
  const thinking = value === "true"
  if (budget !== undefined && thinking && (!capability || !capability.budget)) {
    throw new Error(`${model} does not support a thinking token budget.`)
  }
  return {
    chat_template_kwargs: { enable_thinking: thinking },
    ...(thinking && budget !== undefined && { reasoning_budget_tokens: budget })
  }
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * A call's `modelOptions` over the model card's sampling, as llama.cpp's
 * chat-completion settings. Only these options are sent.
 */
function llamaSettings(
  options: WllamaTextModelOptions | undefined,
  base: Sampling
): Record<string, unknown> {
  const {
    maxCompletionTokens,
    temperature = base.temperature,
    topP = base.topP,
    topK = base.topK,
    minP,
    repetitionPenalty = base.repetitionPenalty,
    frequencyPenalty,
    presencePenalty,
    seed,
    stop,
    parallelToolCalls
  } = options ?? {}
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean")
    throw new TypeError("parallelToolCalls must be a boolean.")
  if (maxCompletionTokens !== undefined && (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 0))
    throw new RangeError("maxCompletionTokens must be a nonnegative safe integer.")
  if (!Number.isFinite(temperature) || temperature < 0)
    throw new RangeError("temperature must be a nonnegative number.")
  if (topP !== undefined && (!Number.isFinite(topP) || topP <= 0 || topP > 1))
    throw new RangeError("topP must be a number in (0, 1].")
  if (!Number.isSafeInteger(topK) || topK < 0)
    throw new RangeError("topK must be a nonnegative safe integer.")
  if (minP !== undefined && (!Number.isFinite(minP) || minP < 0 || minP > 1))
    throw new RangeError("minP must be a number in [0, 1].")
  if (!Number.isFinite(repetitionPenalty) || repetitionPenalty <= 0)
    throw new RangeError("repetitionPenalty must be a positive number.")
  for (const [name, value] of [["frequencyPenalty", frequencyPenalty], ["presencePenalty", presencePenalty]] as const) {
    if (value !== undefined && !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number.`)
  }
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0))
    throw new RangeError("seed must be a nonnegative safe integer.")
  const stops = stop === undefined ? [] : typeof stop === "string" ? [stop] : stop
  if (stops.some((s) => typeof s !== "string" || !s)) throw new TypeError("stop must hold nonempty strings.")
  return {
    temperature,
    top_k: topK,
    repeat_penalty: repetitionPenalty,
    ...(topP !== undefined && { top_p: topP }),
    ...(minP !== undefined && { min_p: minP }),
    ...(frequencyPenalty !== undefined && { frequency_penalty: frequencyPenalty }),
    ...(presencePenalty !== undefined && { presence_penalty: presencePenalty }),
    ...(seed !== undefined && { seed }),
    ...(stops.length > 0 && { stop: stops }),
    ...(maxCompletionTokens !== undefined && { max_tokens: maxCompletionTokens })
  }
}

/** Where a reply's thinking ends; llama.cpp leaves it in the text when thinking is off. */
const THINK_CLOSE = "</think>"

/** Length of the longest end of `text` that could be the start of `THINK_CLOSE`. */
function partialClose(text: string) {
  for (let n = Math.min(THINK_CLOSE.length - 1, text.length); n > 0; n--) {
    if (THINK_CLOSE.startsWith(text.slice(-n))) return n
  }
  return 0
}

let calls = 0
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(calls++).toString(36)}`

export class WllamaTextAdapter<
  TModel extends WllamaChatModel
> extends BaseTextAdapter<
  TModel,
  WllamaTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ResolveReasoning<TModel>
> {
  override readonly kind = "text" as const
  readonly name = "wllama" as const
  override readonly api = "wllama" as const
  override readonly inputModalities = ["text"] as const
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  private readonly loadConfig: WllamaConfig

  constructor(config: WllamaConfig, model: TModel) {
    super({}, model)
    this.onDownloadProgress = config.onDownloadProgress
    this.loadConfig = config
  }

  /**
   * Applies this adapter's options to the runtime when it uses the model
   * (`create()`, a call, or the load it starts), not when it's
   * constructed: constructing an adapter changes nothing shared. Its
   * context length is the model's from then on; runtime options it leaves
   * out, and `keepLoaded` left out, stay as another adapter set them.
   */
  private useModel() {
    const config = this.loadConfig
    setContextLength(this.model, config.contextLength)
    if (config.keepLoaded !== undefined) setKeepLoaded(this.model, config.keepLoaded)
    configureRuntime({
      ...(config.wasmUrl && { wasmUrl: config.wasmUrl }),
      ...(config.compat && { compat: config.compat }),
      ...(config.threads && { threads: config.threads }),
      ...(config.gpu !== undefined && { gpu: config.gpu }),
      ...(config.debug && { debug: true })
    })
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where wllama can't run (no WebAssembly, Web Worker or
   * Origin Private File System, as on a server), "downloading" while this
   * page downloads it, "available" when it's loaded or its GGUF file is in
   * wllama's storage, else "downloadable". It lists wllama's storage only:
   * no worker, no network.
   */
  availability(): Promise<Availability> {
    return availability(this.model)
  }

  /**
   * Loads the model (downloading it the first time), with the download's
   * progress, 0 to 1, then 1 once it's ready. Resolves to this adapter when
   * it's ready; rejects if it can't load (fine to leave unawaited). `chat()` doesn't need it (its
   * first call loads the model), but it lets a page load ahead of time.
   * Adapters for the same model share one loaded model; the page holds one
   * wllama model at a time.
   * Aborting `signal` rejects this call at once with an AbortError and
   * stops its progress reports; if no other caller (another call, or a
   * chat waiting for the model) still waits on the load, the download is
   * cancelled and the model left unloaded.
   */
  create(
    options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}
  ): Promise<this> {
    const { onDownloadProgress } = options
    const own = this.onDownloadProgress
    this.useModel()
    const ready = loadModel(
      this.model,
      own && onDownloadProgress
        ? (progress) => {
            own(progress)
            onDownloadProgress(progress)
          }
        : (own ?? onDownloadProgress),
      options.signal ? { signal: options.signal } : {}
    ).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /**
   * Unloads the model, freeing its memory (and stopping its download), if
   * it's the one loaded (or loading); a running generation of it fails. The
   * model is shared, so this unloads it for every adapter of it. Its file
   * stays downloaded.
   */
  async destroySession(): Promise<void> {
    await unloadModel(this.model)
  }

  /** Sampling and length for a call: `modelOptions` over the model card's, in llama.cpp's names. */
  private settings(modelOptions: WllamaTextModelOptions | undefined, promptCache?: TextOptions["promptCache"]) {
    return {
      ...llamaSettings(modelOptions, modelMeta(this.model).sampling),
      ...(promptCache?.retention === "none" && { cache_prompt: false })
    } as Partial<ChatRequest>
  }

  async *chatStream(
    options: TextOptions<WllamaTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const thinking = thinkingKwargs(options.reasoning, this.model)
    const runId = options.runId ?? nextId("run")
    const threadId = options.threadId
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal =
      options.abortController?.signal ??
      (options.request as RequestInit | undefined)?.signal ??
      undefined
    const model = this.model
    // The loaded model's, once it's loaded.
    let context = 0
    const timestamp = () => Date.now()
    const tools = toTools(options.tools)
    const parallel = options.modelOptions?.parallelToolCalls

    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }

    let reasoning: "none" | "open" | "closed" = "none"
    let text = ""
    let textStarted = false
    /** With `parallelToolCalls: false`, the stream index of the one call kept. */
    let onlyCall: number | undefined
    /** Tool calls by their index in the stream. */
    const toolCalls = new Map<
      number,
      { id: string; name: string; args: string; started: boolean }
    >()
    let finishReason: string | null = null
    let timings: ResultTimings | undefined
    let firstTokenMs: number | null = null
    let failure: string | undefined
    let requested = 0

    const endReasoning = function* () {
      if (reasoning !== "open") return
      reasoning = "closed"
      yield {
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningId,
        model,
        timestamp: timestamp()
      } satisfies AdapterYieldChunk
      yield {
        type: EventType.REASONING_END,
        messageId: reasoningId,
        model,
        timestamp: timestamp()
      } satisfies AdapterYieldChunk
    }

    /** The end of the text so far that could be the start of a stray close. */
    let held = ""
    const addText = function* (raw: string, final = false) {
      // A stray `</think>` is dropped: told not to think, a model sometimes
      // still thinks a little and closes it, and llama.cpp then leaves the
      // close in the text, after what has already streamed as the answer.
      let visible = (held + raw).split(THINK_CLOSE).join("")
      const keep = final ? 0 : partialClose(visible)
      held = visible.slice(visible.length - keep)
      visible = visible.slice(0, visible.length - keep)
      // The answer starts at its first visible character: the newlines
      // after thinking, or before a tool call, aren't a reply.
      const piece = textStarted ? visible : visible.trimStart()
      if (!piece) return
      yield* endReasoning()
      if (!textStarted) {
        textStarted = true
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          model,
          timestamp: timestamp()
        } satisfies AdapterYieldChunk
      }
      text += piece
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: piece,
        content: text,
        model,
        timestamp: timestamp()
      } satisfies AdapterYieldChunk
    }

    try {
      this.useModel()
      const wllama = await waitForModel(model, signal, this.onDownloadProgress).catch((error: unknown) => {
        throw new Error(`Couldn't load ${model}: ${errorText(error)}`)
      })
      context = loadedContext(wllama)
      // Time to first token counts from here, the model loaded.
      requested = performance.now()
      const stream = await streamChat(
        model,
        {
          messages: toMessages(options.systemPrompts, options.messages),
          ...(tools.length && { tools }),
          ...(tools.length && parallel !== undefined && { parallel_tool_calls: parallel }),
          ...this.settings(options.modelOptions, options.promptCache),
          ...thinking
        },
        signal
      )
      for await (const chunk of stream) {
        timings = chunk.timings ?? timings
        const choice = chunk.choices?.[0]
        if (!choice) continue
        finishReason = choice.finish_reason ?? finishReason
        const delta = choice.delta as typeof choice.delta & {
          reasoning_content?: string | null
        }
        if (
          firstTokenMs === null &&
          (delta.reasoning_content || delta.content || delta.tool_calls)
        ) {
          firstTokenMs = performance.now() - requested
        }

        if (delta.reasoning_content) {
          if (reasoning === "none") {
            reasoning = "open"
            yield {
              type: EventType.REASONING_START,
              messageId: reasoningId,
              model,
              timestamp: timestamp()
            }
            yield {
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningId,
              role: "reasoning",
              model,
              timestamp: timestamp()
            }
          }
          yield {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoningId,
            delta: delta.reasoning_content,
            model,
            timestamp: timestamp()
          }
        }

        if (delta.content) yield* addText(delta.content)

        for (const part of delta.tool_calls ?? []) {
          // llama.cpp's grammar allows one call then; its parsers for some
          // templates might still return more, so the first is kept here too.
          if (parallel === false && (onlyCall ??= part.index) !== part.index) continue
          yield* endReasoning()
          let call = toolCalls.get(part.index)
          if (!call) {
            call = { id: part.id ?? nextId("tool"), name: "", args: "", started: false }
            toolCalls.set(part.index, call)
          }
          if (part.function?.name) call.name += part.function.name
          if (!call.started && call.name) {
            call.started = true
            yield {
              type: EventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: call.name,
              parentMessageId: messageId,
              index: part.index,
              model,
              timestamp: timestamp()
            }
          }
          const args = part.function?.arguments ?? ""
          if (args) {
            call.args += args
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: call.id,
              delta: args,
              args: call.args,
              model,
              timestamp: timestamp()
            }
          }
        }
      }
    } catch (error) {
      // Stopped: the reply so far stands.
      if (!signal?.aborted) failure = errorText(contextError(error, context))
    }

    if (held) yield* addText("", true)
    yield* endReasoning()
    for (const call of toolCalls.values()) {
      if (!call.started) continue
      let input: unknown = {}
      try {
        input = call.args ? JSON.parse(call.args) : {}
      } catch {
        // `chat()` reports arguments that aren't JSON to the model.
      }
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: call.id,
        toolCallName: call.name,
        args: call.args,
        input,
        model,
        timestamp: timestamp()
      }
    }
    if (textStarted) {
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: timestamp()
      }
    }

    // Cut off by the context limit, not by a length the caller asked for.
    if (
      !failure &&
      finishReason === "length" &&
      timings &&
      timings.prompt_n + timings.cache_n + timings.predicted_n >= context
    ) {
      failure = `The reply stopped at the model's limit of ${new Intl.NumberFormat("en-US").format(context)} tokens for a session. Start a new session to keep going.`
    }
    if (failure) {
      yield {
        type: EventType.RUN_ERROR,
        model,
        timestamp: timestamp(),
        message: failure,
        error: { message: failure }
      }
      return
    }
    const usage = usageOf(timings, firstTokenMs)
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason:
        toolCalls.size > 0
          ? "tool_calls"
          : finishReason === "length"
            ? "length"
            : "stop",
      ...(usage && { usage })
    }
  }

  /**
   * A JSON answer, constrained to the schema by llama.cpp's JSON Schema
   * grammar, in one whole chat completion; `chat({ outputSchema })` uses
   * `structuredOutputStream` instead, and validates the result.
   */
  async structuredOutput(
    options: StructuredOutputOptions<WllamaTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = chatOptions.abortController?.signal ?? (chatOptions.request as RequestInit | undefined)?.signal ?? undefined
    signal?.throwIfAborted()
    const response = await completeChat(
      this.model,
      {
        messages: toMessages(chatOptions.systemPrompts, chatOptions.messages),
        ...this.settings(chatOptions.modelOptions, chatOptions.promptCache),
        ...thinkingKwargs(chatOptions.reasoning, this.model),
        response_format: {
          type: "json_schema",
          json_schema: { name: "output", schema: outputSchema, strict: true }
        }
      },
      signal
    )
    signal?.throwIfAborted()
    if (response.choices[0]?.finish_reason === "length") {
      throw new Error("The model reached its output limit before structured generation completed.")
    }
    const rawText = response.choices[0]?.message.content?.trim() ?? ""
    const timings = (response as { timings?: ResultTimings }).timings
    try {
      return {
        data: JSON.parse(rawText) as unknown,
        rawText,
        ...(usageOf(timings, null) && { usage: usageOf(timings, null) })
      }
    } catch {
      throw new Error(
        `The model's answer isn't JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? "…" : ""}`
      )
    }
  }

  /**
   * `chat({ outputSchema, stream: true })`: one streamed chat completion
   * constrained to the schema by llama.cpp's JSON Schema grammar. The
   * model's thinking streams as `REASONING_*` events and the raw JSON as
   * `TEXT_MESSAGE_*` deltas, then a `CUSTOM` `structured-output.complete`
   * event with `{ object, raw, reasoning? }` and `RUN_FINISHED` with usage.
   * A failure ends the run with `RUN_ERROR` instead.
   */
  async *structuredOutputStream(
    options: StructuredOutputOptions<WllamaTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const { chatOptions, outputSchema } = options
    const model = this.model
    const runId = chatOptions.runId ?? nextId("run")
    const threadId = chatOptions.threadId
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const signal = chatOptions.abortController?.signal ?? (chatOptions.request as RequestInit | undefined)?.signal ?? undefined
    const timestamp = () => Date.now()
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(chatOptions.parentRunId && { parentRunId: chatOptions.parentRunId })
    }
    let reasoning: "none" | "open" | "closed" = "none"
    let reasoningText = ""
    let textStarted = false
    let text = ""
    let finishReason: string | null = null
    let timings: ResultTimings | undefined
    let firstTokenMs: number | null = null
    let context = 0
    const endReasoning = function* () {
      if (reasoning !== "open") return
      reasoning = "closed"
      yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() } satisfies AdapterYieldChunk
      yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() } satisfies AdapterYieldChunk
    }
    const fail = (message: string, code?: string): AdapterYieldChunk => ({
      type: EventType.RUN_ERROR,
      runId,
      model,
      timestamp: timestamp(),
      message,
      ...(code && { code }),
      error: { message, ...(code && { code }) }
    })
    try {
      const request: ChatRequest = {
        messages: toMessages(chatOptions.systemPrompts, chatOptions.messages),
        ...this.settings(chatOptions.modelOptions, chatOptions.promptCache),
        ...thinkingKwargs(chatOptions.reasoning, model),
        response_format: {
          type: "json_schema",
          json_schema: { name: "output", schema: outputSchema, strict: true }
        }
      }
      signal?.throwIfAborted()
      this.useModel()
      const wllama = await waitForModel(model, signal, this.onDownloadProgress).catch((error: unknown) => {
        throw signal?.aborted ? error : new Error(`Couldn't load ${model}: ${errorText(error)}`)
      })
      context = loadedContext(wllama)
      const requested = performance.now()
      const stream = await streamChat(model, request, signal)
      for await (const chunk of stream) {
        signal?.throwIfAborted()
        timings = chunk.timings ?? timings
        const choice = chunk.choices?.[0]
        if (!choice) continue
        finishReason = choice.finish_reason ?? finishReason
        const delta = choice.delta as typeof choice.delta & { reasoning_content?: string | null }
        if (firstTokenMs === null && (delta.reasoning_content || delta.content)) firstTokenMs = performance.now() - requested
        if (delta.reasoning_content) {
          if (reasoning === "none") {
            reasoning = "open"
            yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
            yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
          }
          reasoningText += delta.reasoning_content
          yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: delta.reasoning_content, model, timestamp: timestamp() }
        }
        // The JSON starts at its first visible character.
        const piece = textStarted ? delta.content : delta.content?.trimStart()
        if (piece) {
          yield* endReasoning()
          if (!textStarted) {
            textStarted = true
            yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
          }
          text += piece
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: piece, content: text, model, timestamp: timestamp() }
        }
      }
      signal?.throwIfAborted()
    } catch (error) {
      yield* endReasoning()
      if (textStarted) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      yield signal?.aborted
        ? fail("The structured output was canceled.", "aborted")
        : fail(errorText(contextError(error, context) ?? error))
      return
    }
    yield* endReasoning()
    if (textStarted) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
    if (finishReason === "length") {
      yield fail("The model reached its output limit before structured generation completed.", "max_tokens")
      return
    }
    const raw = text.trim()
    let object: unknown
    try {
      object = JSON.parse(raw) as unknown
    } catch {
      yield fail(`The model's answer isn't JSON: ${raw.slice(0, 200)}${raw.length > 200 ? "…" : ""}`, "structured-output-parse-failed")
      return
    }
    yield {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: { object, raw, ...(reasoningText && { reasoning: reasoningText }) },
      model,
      timestamp: timestamp()
    }
    const usage = usageOf(timings, firstTokenMs)
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      finishReason: "stop",
      ...(usage && { usage })
    }
  }
}

/**
 * A TanStack AI text adapter for a GGUF model this package lists
 * (`WLLAMA_CHAT_MODELS`), run on the CPU in the browser with wllama.
 *
 * @example
 * ```ts
 * chat({
 *   adapter: wllamaText("LiquidAI/LFM2.5-1.2B-Instruct-GGUF"),
 *   messages,
 *   threadId
 * })
 * ```
 */
export function wllamaText<TModel extends WllamaChatModel>(
  model: TModel,
  config: WllamaConfig = {}
): WllamaTextAdapter<TModel> {
  return new WllamaTextAdapter(config, model)
}
