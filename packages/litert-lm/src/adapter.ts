/**
 * A TanStack AI text adapter for LiteRT-LM, Google's on-device LLM runtime,
 * in the browser (`@litert-lm/core`, on WebGPU). Hand it to `chat()` like any
 * other adapter: `chat()` runs the tools and the agent loop, and each
 * `chatStream` call here is one response of the model, streamed as AG-UI
 * events.
 *
 * A thin layer: the model, the engine's settings and the sampling are
 * LiteRT-LM's own, passed as given. A step is one LiteRT-LM conversation,
 * with the system prompt, the history and the tools as its preface and the
 * last message as the turn sent to it; the model's calls come back from the
 * runtime as calls. What the adapter adds is what the runtime doesn't do: it
 * stores a downloaded model (storage.ts) and keeps one engine for the page
 * (runtime.ts).
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelReasoning, SystemPrompt, TextOptions, TokenUsage, Tool } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import type { ModelReasoningCapability } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"
import type { ConversationConfig, EngineSettings, Message, SessionConfig, Tool as LiteRtTool } from "@litert-lm/core"

import { historyAndTurn, toLiteRtMessages } from "./messages.js"
import { listed, LITERT_LM_MODEL_REASONING, THINKING_SWITCH } from "./model-meta.js"
import type { LiteRtLmChatModel } from "./model-meta.js"
import { abortError, currentEngine, defaultRuntime, engineFor, releaseEngine, runtimeId, waitForEngine } from "./runtime.js"
import type { LiteRtLmRuntime, Loaded, RuntimeConversation, RuntimeEngine } from "./runtime.js"
import { downloadFile, readFile, removeFile, storedFile } from "./storage.js"
import type { ModelFile, StoredModel } from "./storage.js"

/** A download's progress, 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

/**
 * A model the catalog lists, or any other LiteRT-LM takes: a Hugging Face
 * repository (`owner/name`, short for `hf://owner/name`), a `hf://` URI
 * (`hf://owner/name@revision/file.litertlm`), or the URL of a `.litertlm`
 * file.
 */
export type LiteRtLmModel = LiteRtLmChatModel | (string & {})

export type LiteRtLmConfig = {
  /**
   * LiteRT-LM's own `EngineSettings`, as given, without the model: the
   * context length (`mainExecutorSettings.maxNumTokens`), the backend, and so
   * on. `benchmarkEnabled` is on unless set here: it's where a response's
   * token counts come from.
   */
  engineSettings?: Omit<EngineSettings, "model">
  /**
   * The folder LiteRT-LM's WASM files load from (its `loadLiteRtLm`), to
   * serve them yourself: the package's `wasm` folder. By default the runtime
   * loads them from its CDN.
   */
  wasmPath?: string
  /**
   * A Hugging Face access token, for a gated or private model: the token of
   * the user loading it (never your own, in a web page). It is sent when the
   * model's name is resolved and with the download, and not stored.
   */
  accessToken?: string
  /** Hears the model's download, 0 to 1, however it started. */
  onDownloadProgress?: DownloadProgressCallback
  /** The runtime, in place of the `@litert-lm/core` package: a build of your own, or a test's. */
  runtime?: LiteRtLmRuntime | (() => Promise<LiteRtLmRuntime>)
}

/**
 * Per-call `modelOptions`: LiteRT-LM's own `SessionConfig` sampling and
 * reply length, and its conversation switches, under their own names.
 */
export type LiteRtLmTextModelOptions = Pick<SessionConfig, "samplerParams" | "maxOutputTokens"> & {
  /** LiteRT-LM holds the model's tool calls to the tools' schemas (`ConversationConfig.enableConstrainedDecoding`). */
  enableConstrainedDecoding?: boolean
  /** Thinking (the chat template's `enable_thinking`), over `chat()`'s `reasoning`. */
  enableThinking?: boolean
}

export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

/** The catalog's models that think, each with its levels. */
type ReasoningByName = {
  [K in LiteRtLmChatModel as (typeof LITERT_LM_MODEL_REASONING)[K] extends false ? never : K]: ModelReasoningCapability<typeof THINKING_SWITCH>
}

/** A model's reasoning levels: a listed model's, none for a listed one that doesn't think, else the switch. */
type ResolveReasoning<TModel extends string> = TModel extends keyof ReasoningByName
  ? ReasoningByName[TModel]
  : TModel extends LiteRtLmChatModel
    ? never
    : { levels: "off" | "high"; budget: false }

/** The model as LiteRT-LM takes it: a repository name as its `hf://` URI, anything else as given. */
export const modelInput = (model: string) =>
  /^[\w.-]+\/[\w.-]+$/.test(model) && !/\.(litertlm|task)$/i.test(model) ? `hf://${model}` : model

function offeredTools(options: Pick<TextOptions, "toolChoice" | "tools">): ReadonlyArray<Tool> {
  const { toolChoice, tools = [] } = options
  if (toolChoice === "none") return []
  if (typeof toolChoice === "object") return tools.filter((tool) => tool.name === toolChoice.name)
  return tools
}

/** The system instruction: the caller's system prompts, as given. */
const instructionOf = (systemPrompts: ReadonlyArray<SystemPrompt | string> | undefined) =>
  normalizeSystemPrompts(systemPrompts as Array<SystemPrompt> | undefined)
    .map((p) => p.content)
    .filter(Boolean)
    .join("\n\n")

/** The instruction for an answer in a schema, after the caller's system prompts. */
const schemaInstruction = (schema: unknown) =>
  `Answer with one JSON value that is valid for this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`

/** A JSON answer's text: without the code fence a model may put around it. */
const unfenced = (text: string) => {
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text)
  return (fence ? fence[1] : text).trim()
}

/** A chunk's answer text: its string, or its text parts. */
const chunkText = (content: Message["content"]) =>
  typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

const signalOf = (options: TextOptions<LiteRtLmTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class LiteRtLmTextAdapter<TModel extends LiteRtLmModel> extends BaseTextAdapter<
  TModel,
  LiteRtLmTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ResolveReasoning<TModel>
> {
  override readonly kind = "text" as const
  readonly name = "litert-lm" as const
  override readonly provider = "litert-lm" as const
  override readonly api = "litert-lm" as const
  override readonly inputModalities = ["text"] as const
  private readonly engineSettings: Omit<EngineSettings, "model">
  private readonly wasmPath: string | undefined
  private readonly accessToken: string | undefined
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  private readonly runtime: () => Promise<LiteRtLmRuntime>
  /** Which runtime the engine is made by: the package (0), or the one given. */
  private readonly runtimeId: number
  /** The page's engine as this adapter last loaded it. */
  private loaded: Loaded | undefined
  /** Downloads of this adapter's model going on now. */
  private downloading = 0

  constructor(config: LiteRtLmConfig, model: TModel) {
    super({}, model)
    this.engineSettings = { benchmarkEnabled: true, ...config.engineSettings }
    this.wasmPath = config.wasmPath
    this.accessToken = config.accessToken
    this.onDownloadProgress = config.onDownloadProgress
    const runtime = config.runtime
    this.runtimeId = runtimeId(runtime)
    this.runtime = typeof runtime === "function" ? runtime : runtime ? () => Promise.resolve(runtime) : defaultRuntime
  }

  /** What the page's engine is made for: the model and everything it's loaded with. */
  private get key() {
    return JSON.stringify([this.model, this.engineSettings, this.wasmPath ?? null, this.runtimeId])
  }

  /** The model as it's stored: its name, and the backend its file is picked for. */
  private get stored(): StoredModel {
    const backend = this.engineSettings.backend
    return { model: this.model, ...(backend !== undefined && { backend }) }
  }

  /** The model's thinking levels: a listed model's, else the switch (a hint its template ignores where it has none). */
  private get reasoning(): ModelReasoning {
    return listed(this.model) ? LITERT_LM_MODEL_REASONING[this.model] : THINKING_SWITCH
  }

  /**
   * Where the model stands here: "unavailable" without WebGPU, which
   * LiteRT-LM's web runtime needs; "available" once its file is stored (or
   * its engine loaded); "downloading" while this adapter downloads it; else
   * "downloadable" (it downloads at `create`, or at the first `chat()`).
   */
  async availability(): Promise<Availability> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) return "unavailable"
    if (currentEngine()?.key === this.key) return "available"
    if (this.downloading > 0) return "downloading"
    return (await storedFile(this.stored)) ? "available" : "downloadable"
  }

  /** Tokens a conversation can hold (the engine's `maxNumTokens`), once the model is loaded. */
  async contextSize(): Promise<number | undefined> {
    const loaded = currentEngine()
    if (loaded?.key !== this.key) return undefined
    const size = (await loaded.engine.catch(() => undefined))?.settings?.mainExecutorSettings?.maxNumTokens
    return typeof size === "number" && size > 0 ? size : undefined
  }

  /**
   * Downloads the model if it isn't stored and loads its engine, with the
   * download's progress, 0 to 1, then 1 once it's ready. Resolves to this
   * adapter; rejects if it can't load (fine to leave unawaited). `chat()`
   * doesn't need it: the first response loads the model too. Aborting
   * `signal` stops this call's wait; a load others are waiting for too goes
   * on for them, and stops once nobody waits for it.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const ready = this.engine(options.signal, options.onDownloadProgress).then(() => {
      options.onDownloadProgress?.(1)
      this.onDownloadProgress?.(1)
      return this
    })
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /** Deletes the model's engine, if it's the page's. The stored file stays. */
  async destroy(): Promise<void> {
    const loaded = this.loaded
    this.loaded = undefined
    if (loaded) await releaseEngine(loaded)
  }

  /** Removes the model's stored file, after its engine. Returns whether a file was stored. */
  async remove(): Promise<boolean> {
    await this.destroy()
    return removeFile(this.stored)
  }

  /**
   * The model for `Engine.create`: its stored file's bytes, downloaded first
   * if they aren't stored; where the page has no Cache Storage, its URL, which
   * the runtime streams itself. A name is resolved as the engine will load
   * it: for the engine's backend, and with the model's access token.
   */
  private async source(runtime: LiteRtLmRuntime, signal: AbortSignal, report: DownloadProgressCallback): Promise<EngineSettings["model"]> {
    let file = await storedFile(this.stored)
    if (!file) {
      const input = modelInput(this.model)
      const { backend } = this.engineSettings
      const resolved = (
        await runtime.resolveModel(this.accessToken ? { url: input, accessToken: this.accessToken } : input, {
          ...(backend !== undefined && { backend }),
          signal
        })
      ).model
      const found: ModelFile | undefined =
        typeof resolved === "string"
          ? { url: resolved }
          : resolved && typeof (resolved as ModelFile).url === "string"
            ? { url: (resolved as ModelFile).url, size: (resolved as ModelFile).size, sha256: (resolved as ModelFile).sha256 }
            : undefined
      if (!found) throw new Error(`${this.model} didn't resolve to a file's URL`)
      file = { ...found, url: typeof document === "undefined" ? found.url : new URL(found.url, document.baseURI).href }
      if (typeof caches === "undefined") return this.accessToken ? { url: file.url, accessToken: this.accessToken } : file.url
      this.downloading++
      try {
        await downloadFile(this.stored, file, { onProgress: report, signal, ...(this.accessToken && { accessToken: this.accessToken }) })
      } finally {
        this.downloading--
      }
    }
    const bytes = await readFile(file)
    if (!bytes) throw new Error(`${this.model}'s stored file is gone`)
    return bytes
  }

  /**
   * The page's engine for this adapter's model: loaded now if it isn't (the
   * model downloaded first if it isn't stored). A load is shared: `signal`
   * stops this caller's wait, and the load itself only once nobody else waits
   * for it; `progress` hears the download while this caller waits.
   */
  private engine(signal?: AbortSignal, progress?: DownloadProgressCallback): Promise<RuntimeEngine> {
    this.loaded = engineFor(this.key, async (stopped, report) => {
      const runtime = await this.runtime()
      if (this.wasmPath) await runtime.loadLiteRtLm?.(this.wasmPath)
      const model = await this.source(runtime, stopped, report)
      const engine = await runtime.Engine.create({ ...this.engineSettings, model })
      // Stopped while the engine was made: nobody waits for it.
      if (stopped.aborted) {
        await engine.delete().catch(() => undefined)
        throw abortError(stopped)
      }
      return engine
    })
    return waitForEngine(
      this.loaded,
      signal,
      [this.onDownloadProgress, progress].filter((listener) => listener !== undefined)
    )
  }

  /** Thinking for a step: `enableThinking`, else `reasoning` at the model's levels. Undefined: the template's own default. */
  private thinking(options: TextOptions<LiteRtLmTextModelOptions>): boolean | undefined {
    const asked = options.modelOptions?.enableThinking
    if (asked !== undefined) return asked
    const level = resolveReasoning(options.reasoning, this.reasoning)?.value
    return level === undefined ? undefined : level === "true"
  }

  /** A step's conversation: LiteRT-LM's `ConversationConfig`, with the history as its preface. */
  private conversationConfig(
    options: TextOptions<LiteRtLmTextModelOptions>,
    step: { system: string; history: Array<Message>; tools: ReadonlyArray<Tool>; thinking: boolean | undefined }
  ): ConversationConfig {
    const { samplerParams, maxOutputTokens, enableConstrainedDecoding } = options.modelOptions ?? {}
    const tools = step.tools.map(
      (tool) =>
        ({
          type: "function",
          function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object", properties: {} } }
        }) as LiteRtTool
    )
    return {
      preface: {
        messages: [...(step.system ? [{ role: "system", content: step.system }] : []), ...step.history],
        ...(tools.length > 0 && { tools }),
        ...(step.thinking !== undefined && { extra_context: { enable_thinking: step.thinking } })
      },
      ...((samplerParams !== undefined || maxOutputTokens !== undefined) && {
        sessionConfig: { ...(samplerParams !== undefined && { samplerParams }), ...(maxOutputTokens !== undefined && { maxOutputTokens }) }
      }),
      ...(enableConstrainedDecoding !== undefined && { enableConstrainedDecoding })
    }
  }

  /**
   * One response: a conversation made with `config`, sent `turn`, its chunks
   * as the runtime streams them. `finished` hears the conversation once the
   * response has ended, before it's deleted. Aborting `signal` cancels the
   * generation.
   */
  private async *respond(
    config: ConversationConfig,
    turn: Message,
    signal: AbortSignal | undefined,
    finished?: (conversation: RuntimeConversation) => Promise<void>
  ): AsyncGenerator<Message> {
    const engine = await this.engine(signal)
    signal?.throwIfAborted()
    const conversation = await engine.createConversation(config)
    let reader: ReadableStreamDefaultReader<Message> | undefined
    const stop = () => {
      conversation.cancel()
      void reader?.cancel().catch(() => undefined)
    }
    signal?.addEventListener("abort", stop, { once: true })
    try {
      signal?.throwIfAborted()
      reader = conversation.sendMessageStreaming(turn).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        yield value
      }
      await finished?.(conversation)
      // (Stopped while the response's counts were read: it didn't end well.)
      signal?.throwIfAborted()
    } finally {
      signal?.removeEventListener("abort", stop)
      // A stream left before its response ended (stopped, failed, or left by its reader) stops the response.
      void reader?.cancel().catch(() => undefined)
      await conversation.delete().catch(() => undefined)
    }
  }

  /** A response's token counts, from the engine's benchmark: nothing where it isn't on, or counted none. */
  private async usage(conversation: RuntimeConversation): Promise<{ usage: TokenUsage; written: number } | undefined> {
    try {
      const { lastPrefillTokenCount: read, lastDecodeTokenCount: written } = await conversation.getBenchmarkInfo()
      if (!(read > 0) && !(written > 0)) return undefined
      return { usage: buildBaseUsage({ promptTokens: read, completionTokens: written, totalTokens: read + written }), written }
    } catch {
      return undefined
    }
  }

  async *chatStream(options: TextOptions<LiteRtLmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const { threadId } = options
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const model = this.model
    const signal = signalOf(options)
    const timestamp = () => Date.now()
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }

    try {
      signal?.throwIfAborted()
      const { history, turn } = historyAndTurn(toLiteRtMessages(options.messages))
      const config = this.conversationConfig(options, {
        system: instructionOf(options.systemPrompts),
        history,
        tools: offeredTools(options),
        thinking: this.thinking(options)
      })

      let text = ""
      let reasoningOpen = false
      const closeReasoning = function* (): Generator<AdapterYieldChunk> {
        if (!reasoningOpen) return
        reasoningOpen = false
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
        yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
      }
      const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        yield* closeReasoning()
        if (!text) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
        text += delta
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content: text, model, timestamp: timestamp() }
      }
      const reasoningEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        if (!reasoningOpen) {
          reasoningOpen = true
          yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
          yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
        }
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta, model, timestamp: timestamp() }
      }

      const calls: Array<{ id: string; name: string; arguments: string }> = []
      let counted: Awaited<ReturnType<LiteRtLmTextAdapter<TModel>["usage"]>>
      for await (const chunk of this.respond(config, turn, signal, async (conversation) => {
        counted = await this.usage(conversation)
      })) {
        // Thinking comes in the chunk's channels, the answer in its content, calls as calls.
        for (const thought of Object.values(chunk.channels ?? {})) yield* reasoningEvents(thought)
        yield* textEvents(chunkText(chunk.content))
        for (const call of chunk.tool_calls ?? []) {
          calls.push({ id: call.id || nextId("call"), name: call.function.name, arguments: JSON.stringify(call.function.arguments ?? {}) })
        }
      }
      // Stopped after the last chunk, while the conversation was closed: no calls go out, and the run doesn't finish.
      signal?.throwIfAborted()

      yield* closeReasoning()
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      for (const [index, call] of calls.entries()) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name, parentMessageId: messageId, index, model, timestamp: timestamp() }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: call.arguments, args: call.arguments, model, timestamp: timestamp() }
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: call.id,
          toolCallName: call.name,
          args: call.arguments,
          input: JSON.parse(call.arguments) as unknown,
          model,
          timestamp: timestamp()
        }
      }
      const cap = options.modelOptions?.maxOutputTokens
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model,
        timestamp: timestamp(),
        finishReason: calls.length > 0 ? "tool_calls" : cap !== undefined && counted !== undefined && counted.written >= cap ? "length" : "stop",
        ...(counted && { usage: counted.usage })
      }
    } catch (error) {
      const aborted = !!signal?.aborted
      options.logger.errors("litert-lm chatStream failed", { error, source: "litert-lm.chatStream" })
      const message = error instanceof Error ? error.message : String(error)
      const code = aborted ? "aborted" : (error as { code?: unknown })?.code
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: timestamp(),
        message,
        // At the top too: chat() puts only this one on the error it throws.
        ...(typeof code === "string" && { code }),
        error: { message, ...(typeof code === "string" && { code }) }
      }
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`. LiteRT-LM's web runtime holds
   * a model's tool calls to a schema, not its answers, so the schema goes into
   * the system instruction, after the caller's, and the answer is read as
   * JSON, with thinking off. Nothing holds the model to the schema: check the
   * answer (`chat()` does, with the schema).
   */
  async structuredOutput(options: StructuredOutputOptions<LiteRtLmTextModelOptions>): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    signal?.throwIfAborted()
    const { history, turn } = historyAndTurn(toLiteRtMessages(chatOptions.messages))
    const config = this.conversationConfig(chatOptions, {
      system: [instructionOf(chatOptions.systemPrompts), schemaInstruction(outputSchema)].filter(Boolean).join("\n\n"),
      history,
      tools: [],
      // Off where the model has the switch: the answer is the JSON alone.
      thinking: this.reasoning === false ? undefined : false
    })
    let text = ""
    let counted: Awaited<ReturnType<LiteRtLmTextAdapter<TModel>["usage"]>>
    for await (const chunk of this.respond(config, turn, signal, async (conversation) => {
      counted = await this.usage(conversation)
    })) {
      text += chunkText(chunk.content)
    }
    // Stopped after the last chunk, while the conversation was closed: no answer.
    signal?.throwIfAborted()
    const cap = chatOptions.modelOptions?.maxOutputTokens
    if (cap !== undefined && counted !== undefined && counted.written >= cap) {
      throw Object.assign(new Error("The answer was cut off before it was complete (maxOutputTokens)"), { code: "length" })
    }
    const rawText = unfenced(text)
    // A SyntaxError, TanStack's parse failure, if it isn't JSON.
    return { data: JSON.parse(rawText) as unknown, rawText, model: this.model, ...(counted && { usage: counted.usage }) }
  }
}

/**
 * A TanStack AI text adapter for a LiteRT-LM model in the browser, on WebGPU.
 *
 * @example
 * ```ts
 * const adapter = litertLmText("litert-community/gemma-4-E2B-it-litert-lm")
 * if ((await adapter.availability()) !== "unavailable") {
 *   chat({ adapter, messages, tools }) // downloads the model the first time
 * }
 * ```
 */
export function litertLmText<TModel extends LiteRtLmModel>(model: TModel, config: LiteRtLmConfig = {}): LiteRtLmTextAdapter<TModel> {
  return new LiteRtLmTextAdapter(config, model)
}
