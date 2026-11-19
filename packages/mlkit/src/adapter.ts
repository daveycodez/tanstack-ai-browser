/**
 * A TanStack AI text adapter for Gemini Nano on Android, through ML Kit's
 * GenAI Prompt API: the Capacitor plugin, or any host that implements
 * `MlKitNative`. Hand it to `chat()` like any other adapter: `chat()` runs
 * the tools and the agent loop, and each `chatStream` call here is one
 * response of the model, streamed as AG-UI events.
 *
 * Tools are ML Kit's own (its function calling): the model's calls come back
 * as calls, not as text to read them from. ML Kit keeps no conversation, so
 * every step sends all of it: the system instruction, the tools, and the
 * messages, with earlier calls and their results as ML Kit's own parts.
 */
import { EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, SystemPrompt, TextOptions, Tool } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { callTextFilter } from "./call-text.js"
import { toNativeContents } from "./messages.js"
import { MLKIT_MODEL_REASONING } from "./model-meta.js"
import type { MlKitChatModel } from "./model-meta.js"
import { MlKit } from "./native.js"
import type { MlKitFeature, MlKitModelConfig, MlKitNative, NativeAvailability, NativeEvent, NativeRequest } from "./native.js"
import { toNativeSchema } from "./schema.js"
import { variantOf } from "./variant.js"
import type { MlKitVariant } from "./variant.js"

/** A download's progress, 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

export type MlKitConfig = MlKitModelConfig & {
  /** The native side. By default the Capacitor plugin (`MlKit`). */
  native?: MlKitNative
  /** Hears the model's download, 0 to 1, however it started. */
  onDownloadProgress?: DownloadProgressCallback
}

/** Per-call `modelOptions`: ML Kit's sampling settings and reply length. */
export type MlKitTextModelOptions = {
  /** 0 to 1. Left out, ML Kit's default (0). */
  temperature?: number
  /** Left out, ML Kit's default (3). */
  topK?: number
  /** Repeats a response. Left out, a different one each time. */
  seed?: number
  /** Most tokens to generate. Left out, the model's own reply length. */
  maxOutputTokens?: number
  /** Thinking mode, over `chat()`'s `reasoning`: where the model has it (Gemini Nano 4). */
  enableThinking?: boolean
}

export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

type ResponseEvent = Extract<NativeEvent, { requestId: string }>

/** Events of one native response, as they come. */
class EventQueue {
  private readonly events: Array<ResponseEvent> = []
  private wake: (() => void) | undefined

  push(event: ResponseEvent) {
    this.events.push(event)
    this.wake?.()
    this.wake = undefined
  }

  async next(signal: AbortSignal | undefined): Promise<ResponseEvent> {
    // Stopped: not even an event already here (a buffered done) goes out.
    signal?.throwIfAborted()
    while (this.events.length === 0) {
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
        this.wake = () => {
          signal?.removeEventListener("abort", abort)
          resolve()
        }
        signal?.addEventListener("abort", abort, { once: true })
      })
    }
    return this.events.shift() as ResponseEvent
  }
}

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

/**
 * The instruction for an answer in a schema, after the caller's system
 * prompts. (ML Kit's own words for its compiled schemas, "you MUST output
 * ONLY in the following JSON schema", made Gemini Nano 4 fill in a JSON
 * Schema itself: `{"type":"object","properties":{"city":"Paris"}}`.)
 */
const schemaInstruction = (schema: unknown) =>
  `Answer with one JSON value that is valid for this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`

/** The word Gemini Nano's thinking opens with, on a line of its own: the channel's name, not a thought. */
const THOUGHT_LABEL = "thought\n"

/** A JSON answer's text: without the code fence a model may put around it. */
const unfenced = (text: string) => {
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text)
  return (fence ? fence[1] : text).trim()
}

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

const signalOf = (options: TextOptions<MlKitTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export class MlKitTextAdapter extends BaseTextAdapter<
  MlKitChatModel,
  MlKitTextModelOptions,
  readonly ["text", "image"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  { levels: "off" | "high"; budget: false }
> {
  override readonly kind = "text" as const
  readonly name = "mlkit" as const
  override readonly provider = "mlkit" as const
  override readonly api = "mlkit" as const
  override readonly inputModalities = ["text", "image"] as const
  private readonly native: MlKitNative
  /** ML Kit's model for this adapter; undefined for its default (stable, full). */
  private readonly modelConfig: MlKitModelConfig | undefined
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  /** Responses streaming now, by request, and downloads' listeners, by download. */
  private readonly queues = new Map<string, EventQueue>()
  private readonly downloads = new Map<string, (progress: number) => void>()
  private listening: Promise<unknown> | undefined

  constructor(config: MlKitConfig, model: MlKitChatModel) {
    super({}, model)
    this.native = config.native ?? MlKit
    this.modelConfig =
      config.releaseStage || config.preference
        ? { ...(config.releaseStage && { releaseStage: config.releaseStage }), ...(config.preference && { preference: config.preference }) }
        : undefined
    this.onDownloadProgress = config.onDownloadProgress
  }

  private get modelOption() {
    return this.modelConfig ? { model: this.modelConfig } : {}
  }

  private async status(): Promise<NativeAvailability> {
    try {
      return await this.native.availability(this.modelOption)
    } catch {
      // No plugin here (a browser, iOS): ML Kit's model can't run.
      return { status: "unavailable" }
    }
  }

  /**
   * ML Kit's `checkStatus()` for this adapter's model: "available" (on the
   * device), "downloadable" or "downloading" (AICore gets it, at `create`),
   * or "unavailable" (not Android, or a device AICore has no model for).
   */
  async availability(): Promise<Availability> {
    return (await this.status()).status
  }

  /** Tokens a request and its response share (ML Kit's `getTokenLimit()`), once the model is on the device. */
  async contextSize(): Promise<number | undefined> {
    return (await this.status()).tokenLimit
  }

  /**
   * Which Gemini Nano runs here, as ML Kit names it ("nano-v4-full"), with
   * its version and a name to show ("Gemini Nano 4"). Undefined until the
   * model is on the device.
   */
  async variant(): Promise<MlKitVariant | undefined> {
    const name = (await this.status()).baseModelName
    return name ? variantOf(name) : undefined
  }

  /**
   * What the model on the device can do, as ML Kit reports it: a system
   * prompt (Gemini Nano 3 and later), thinking mode and function calling
   * (4), and so on. Empty until the model is on the device.
   */
  async features(): Promise<Array<MlKitFeature>> {
    return (await this.status()).features ?? []
  }

  /**
   * Downloads the model if it isn't on the device and loads it, with the
   * download's progress, 0 to 1, then 1 once it's ready. Resolves to this
   * adapter; rejects if it can't run here (fine to leave unawaited).
   * `chat()` doesn't need it once the model is on the device. Aborting
   * `signal` stops this wait, not AICore's download.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const listeners = [this.onDownloadProgress, options.onDownloadProgress].filter((l) => !!l)
    const report = (progress: number) => {
      for (const listener of listeners) listener(progress)
    }
    const load = async () => {
      options.signal?.throwIfAborted()
      const answer = await this.native.availability(this.modelOption)
      if (answer.status === "unavailable") {
        throw Object.assign(new Error(`Gemini Nano is unavailable here (${answer.reason ?? "unavailable"})`), { code: answer.reason ?? "unavailable" })
      }
      if (answer.status !== "available") {
        await this.listen()
        const downloadId = nextId("download")
        this.downloads.set(downloadId, report)
        try {
          await this.native.download({ downloadId, ...this.modelOption })
        } finally {
          this.downloads.delete(downloadId)
        }
      }
      options.signal?.throwIfAborted()
      await this.native.warmup(this.modelOption)
      report(1)
      return this
    }
    const stopped = new Promise<never>((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")), { once: true })
    })
    const ready = Promise.race([load(), stopped])
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /**
   * The tokens ML Kit counts for a conversation's input (its `countTokens()`):
   * the messages, with the system prompts and tools it would be sent with.
   */
  async countTokens(options: Pick<TextOptions<MlKitTextModelOptions>, "messages" | "systemPrompts" | "tools" | "toolChoice">): Promise<number> {
    return (await this.native.countTokens(await this.request(options, options.messages))).totalTokens
  }

  /** Stops every response streaming now. AICore keeps the model. */
  async destroy(): Promise<void> {
    for (const [requestId, queue] of this.queues) {
      queue.push({ requestId, type: "error", code: "closed", message: "The adapter was closed" })
      void this.native.cancel({ requestId }).catch(() => undefined)
    }
    this.queues.clear()
  }

  /** Routes the native events to their response, or their download. Listens once. */
  private listen() {
    this.listening ??= this.native.addListener("event", (event) => {
      if (event.type === "download") {
        // Bytes so far of the download's size; under 1 until it's done.
        if (event.total > 0) this.downloads.get(event.downloadId)?.(Math.min(event.downloaded / event.total, 0.999))
        return
      }
      this.queues.get(event.requestId)?.push(event)
    })
    return this.listening
  }

  /** ML Kit's request for a step: the whole conversation, the system instruction, the tools. */
  private async request(
    options: Pick<TextOptions<MlKitTextModelOptions>, "systemPrompts" | "tools" | "toolChoice">,
    messages: ReadonlyArray<ModelMessage>
  ): Promise<NativeRequest> {
    const systemInstruction = instructionOf(options.systemPrompts)
    const tools = offeredTools(options)
    return {
      ...this.modelOption,
      ...(systemInstruction && { systemInstruction }),
      contents: await toNativeContents(messages),
      ...(tools.length > 0 && {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: toNativeSchema(tool.inputSchema ?? { type: "object", properties: {} })
        }))
      })
    }
  }

  /**
   * A request's sampling settings and reply length, and thinking as asked
   * (`reasoning`, or `enableThinking` over it) where the answer may have it.
   */
  private settings(options: TextOptions<MlKitTextModelOptions>, mayThink = true): NonNullable<NativeRequest["options"]> {
    const { temperature, topK, seed, maxOutputTokens, enableThinking } = options.modelOptions ?? {}
    const level = resolveReasoning(options.reasoning, MLKIT_MODEL_REASONING[this.model])?.value
    const thinking = mayThink && (enableThinking ?? (level === undefined ? undefined : level === "true"))
    return {
      ...(temperature !== undefined && { temperature }),
      ...(topK !== undefined && { topK }),
      ...(seed !== undefined && { seed }),
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(thinking && { enableThinking: true })
    }
  }

  async *chatStream(options: TextOptions<MlKitTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const { threadId } = options
    const messageId = nextId("msg")
    const reasoningId = nextId("reasoning")
    const requestId = nextId("request")
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

    let started = false
    try {
      // A stopped request starts no native work (and one stopped meanwhile ends here).
      signal?.throwIfAborted()
      await this.listen()
      const request = await this.request(options, options.messages)
      signal?.throwIfAborted()
      const queue = new EventQueue()
      this.queues.set(requestId, queue)
      started = true
      await this.native.generate({ requestId, ...request, options: this.settings(options) })

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
      // A tool call's own text, in the thinking and in the response, stays out: the call is its own event.
      const thinking = callTextFilter()
      const answer = callTextFilter()
      /** The thinking's first characters, until they're known to be its label or not. */
      let opening: string | undefined = ""
      const thought = (piece: string) => {
        if (opening === undefined) return piece
        opening += piece
        if (THOUGHT_LABEL.startsWith(opening)) return ""
        const rest = opening.startsWith(THOUGHT_LABEL) ? opening.slice(THOUGHT_LABEL.length) : opening
        opening = undefined
        return rest
      }
      for (;;) {
        const event = await queue.next(signal)
        if (event.type === "thought") {
          yield* reasoningEvents(thought(thinking.push(event.text)))
        } else if (event.type === "delta") {
          yield* textEvents(answer.push(event.text))
        } else if (event.type === "done") {
          const calls = event.toolCalls ?? []
          yield* reasoningEvents(thought(thinking.end(calls.length > 0)))
          // Thinking that was only the start of its label, after all.
          if (opening && opening !== THOUGHT_LABEL) yield* reasoningEvents(opening)
          yield* textEvents(answer.end(calls.length > 0))
          yield* closeReasoning()
          if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
          for (const [index, call] of calls.entries()) {
            yield {
              type: EventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: call.name,
              parentMessageId: messageId,
              index,
              model,
              timestamp: timestamp()
            }
            yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: call.arguments, args: call.arguments, model, timestamp: timestamp() }
            yield {
              type: EventType.TOOL_CALL_END,
              toolCallId: call.id,
              toolCallName: call.name,
              args: call.arguments,
              input: parse(call.arguments),
              model,
              timestamp: timestamp()
            }
          }
          yield {
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            model,
            timestamp: timestamp(),
            finishReason: calls.length > 0 ? "tool_calls" : event.finishReason === "length" ? "length" : "stop"
          }
          return
        } else {
          throw Object.assign(new Error(event.message), { code: event.code })
        }
      }
    } catch (error) {
      const aborted = !!signal?.aborted
      if (started && aborted) void this.native.cancel({ requestId }).catch(() => undefined)
      options.logger.errors("mlkit chatStream failed", { error, source: "mlkit.chatStream" })
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
    } finally {
      this.queues.delete(requestId)
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`. ML Kit holds answers only to
   * schemas compiled into the app (`@Generable` classes), not to one given at
   * run time, so the schema goes into the system instruction, after the
   * caller's, and the answer is read as JSON. Nothing holds the model to the
   * schema: check the answer (`chat()` does, with the schema).
   */
  async structuredOutput(options: StructuredOutputOptions<MlKitTextModelOptions>): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    signal?.throwIfAborted()
    await this.listen()
    const asked = await this.request({ systemPrompts: chatOptions.systemPrompts }, chatOptions.messages)
    const request = { ...asked, systemInstruction: [asked.systemInstruction, schemaInstruction(outputSchema)].filter(Boolean).join("\n\n") }
    signal?.throwIfAborted()
    const requestId = nextId("request")
    const queue = new EventQueue()
    this.queues.set(requestId, queue)
    try {
      // (Thinking stays off: the answer is the JSON alone.)
      await this.native.generate({ requestId, ...request, options: this.settings(chatOptions, false) })
      for (;;) {
        const event = await queue.next(signal)
        if (event.type === "done") {
          if (event.finishReason === "length") {
            throw Object.assign(new Error("The answer was cut off before it was complete (maxOutputTokens, or the model's own limit)"), { code: "length" })
          }
          const rawText = unfenced(event.text)
          // A SyntaxError, TanStack's parse failure, if it isn't JSON.
          return { data: JSON.parse(rawText) as unknown, rawText, model: this.model }
        }
        if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code })
      }
    } catch (error) {
      if (signal?.aborted) void this.native.cancel({ requestId }).catch(() => undefined)
      throw error
    } finally {
      this.queues.delete(requestId)
    }
  }
}

/**
 * A TanStack AI text adapter for Gemini Nano on Android, through ML Kit's
 * GenAI Prompt API (the Capacitor plugin, by default). The model is the
 * device's Gemini Nano ("gemini-nano"), so naming it is optional.
 *
 * @example
 * ```ts
 * const adapter = mlkitText()
 * if ((await adapter.availability()) !== "unavailable") {
 *   await adapter.create() // downloads the model, if AICore doesn't have it yet
 *   chat({ adapter, messages, tools })
 * }
 * ```
 */
export function mlkitText(config?: MlKitConfig): MlKitTextAdapter
export function mlkitText(model: MlKitChatModel, config?: MlKitConfig): MlKitTextAdapter
export function mlkitText(modelOrConfig?: MlKitChatModel | MlKitConfig, config: MlKitConfig = {}): MlKitTextAdapter {
  return typeof modelOrConfig === "string" ? new MlKitTextAdapter(config, modelOrConfig) : new MlKitTextAdapter(modelOrConfig ?? {}, "gemini-nano")
}
