/**
 * A TanStack AI text adapter for the browser's built-in language model,
 * through the Prompt API (`LanguageModel`): Gemini Nano in Chrome,
 * Phi-4-mini in Edge. The browser downloads and runs the model itself;
 * nothing leaves the device. Hand it to `chat()` like any hosted model's
 * adapter: `chat()` runs tools and the agent loop, and each `chatStream`
 * call here is one step of the model, streamed back as AG-UI events.
 *
 * Each thread (`threadId`) keeps a session: a step prompts it with only the
 * messages it hasn't seen, and a conversation that changed (an edit, a new
 * system prompt) starts a new one. Tools go by prompt (`tools.ts`);
 * structured output prompts the thread's session under the Prompt API's own
 * `responseConstraint`.
 */
import { EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, Tool } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { contentText, mediaIn, toLanguageModelMessages } from "./messages.js"
import { baseOptions, createSession, DEFAULT_LANGUAGES, promptApiAvailability } from "./model.js"
import type { Availability, MediaInput } from "./model.js"
import type { PromptApiChatModel } from "./model-meta.js"
import { toolCallReader, toolSystemPrompt } from "./tools.js"
import type { DownloadProgressCallback, LanguageModelSession, SamplingMode } from "./types.js"

export type PromptApiConfig = {
  /**
   * Languages the conversation is in, input and output: ["en"] by default.
   * Chrome's model takes "en", "es", "ja", "de" and "fr", and checks its
   * safety filters for the output language.
   */
  languages?: ReadonlyArray<string>
  /**
   * Kinds of input besides text the conversation will have ("image",
   * "audio"), for `availability()`: images need more of the device, audio a
   * GPU. Text only by default. Sessions expect what each conversation has.
   */
  inputs?: ReadonlyArray<MediaInput>
  /**
   * The browser's download of its model, 0 to 1, when a call starts it; then
   * 1 once a session has started. To download ahead of time, see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
  /**
   * Called when a thread's session overflows its context window (the
   * session's `contextoverflow` event): Chrome then drops the oldest
   * messages after the system prompt to make room.
   */
  onContextOverflow?: (event: Event) => void
}

/** Per-call `modelOptions`: the session's sampling. */
export type PromptApiTextModelOptions = {
  /**
   * Sampling preset, "most-predictable" to "most-creative" ("balanced" by
   * default). Chrome takes it on web pages only in its Sampling Parameters
   * origin trial.
   */
  samplingMode?: SamplingMode
  /** Raw sampling, for extensions (web pages ignore it); `samplingMode` wins. */
  temperature?: number
  topK?: number
}

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

/**
 * Threads that keep a session open; the least recently used closes first. A
 * session holds its conversation in the model's memory (about 100 MB for
 * 6,000 tokens in Chrome 156), freed only by `destroy()`.
 */
const KEPT_SESSIONS = 4

/** A thread's session, the settings it was made with, and the messages it holds. */
type Kept = { session: LanguageModelSession; settings: string; seen: Array<string>; busy: boolean }

/**
 * A message as compared with what a session holds. The model's own replies
 * go by their text alone: the session has them as the model wrote them.
 */
const messageKey = (m: ModelMessage) =>
  m.role === "assistant"
    ? JSON.stringify(["assistant", contentText(m.content).trim()])
    : JSON.stringify([m.role, m.content, m.toolCallId ?? null, m.error ?? null])

/** A step's system prompt (the caller's, then the tools), and the settings its session is made with. */
function sessionSettings(options: TextOptions<PromptApiTextModelOptions>, tools: ReadonlyArray<Tool>) {
  const system = toolSystemPrompt(
    normalizeSystemPrompts(options.systemPrompts)
      .map((p) => p.content)
      .join("\n\n"),
    tools
  )
  const { samplingMode, temperature, topK } = options.modelOptions ?? {}
  return { system, settings: JSON.stringify([system, samplingMode, temperature, topK, mediaIn(options.messages)]) }
}

/** Whether a conversation (its messages' keys) goes on from what a kept session holds, with its settings. */
const goesOnFrom = (held: Kept, settings: string, keys: Array<string>) =>
  !held.busy && held.settings === settings && held.seen.length < keys.length && held.seen.every((key, i) => key === keys[i])

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions<PromptApiTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined


export class PromptApiTextAdapter extends BaseTextAdapter<
  PromptApiChatModel,
  PromptApiTextModelOptions,
  readonly ["text", "image", "audio"],
  MetadataByModality
> {
  override readonly kind = "text" as const
  readonly name = "prompt-api" as const
  override readonly provider = "prompt-api" as const
  override readonly api = "prompt-api" as const
  override readonly inputModalities = ["text", "image", "audio"] as const
  private readonly languages: ReadonlyArray<string>
  private readonly inputs: ReadonlyArray<MediaInput>
  private readonly onDownloadProgress: DownloadProgressCallback | undefined
  private readonly onContextOverflow: ((event: Event) => void) | undefined
  /** Each thread's session, least recently used first. */
  private readonly kept = new Map<string, Kept>()

  constructor(config: PromptApiConfig, model: PromptApiChatModel) {
    super({}, model)
    this.languages = config.languages ?? DEFAULT_LANGUAGES
    this.inputs = config.inputs ?? []
    this.onDownloadProgress = config.onDownloadProgress
    this.onContextOverflow = config.onContextOverflow
  }

  /**
   * The browser's own `LanguageModel.availability()` for this adapter's
   * `languages` and `inputs`: "available" (on the device), "downloadable"
   * or "downloading" (it downloads when a session starts, or at `create`),
   * or "unavailable" (no Prompt API, or the device can't run it).
   */
  availability(): Promise<Availability> {
    return promptApiAvailability(baseOptions(this.languages, this.inputs))
  }

  /**
   * Downloads the browser's model if it isn't on the device and starts it,
   * with the download's progress, 0 to 1, then 1 once it's ready. Resolves
   * to this adapter; rejects if it can't start (fine to leave unawaited).
   * `chat()` doesn't need it, but the browser asks for a click on the page
   * before a download: call it from the click that turns the model on.
   * Aborting `signal` aborts the browser's `create()`.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const listeners = [this.onDownloadProgress, options.onDownloadProgress].filter((l) => !!l)
    const ready = createSession(baseOptions(this.languages), options.signal, (progress) => {
      for (const listener of listeners) listener(progress)
    }).then((session) => {
      session.destroy()
      return this
    })
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /** Closes every thread's session. The browser keeps the model. */
  async destroy(): Promise<void> {
    for (const kept of this.kept.values()) kept.session.destroy()
    this.kept.clear()
  }

  /** Keeps a thread's session, closing the least recently used past the limit. */
  private keep(threadId: string, kept: Kept) {
    this.kept.delete(threadId)
    this.kept.set(threadId, kept)
    for (const [id, old] of this.kept) {
      if (this.kept.size <= KEPT_SESSIONS) break
      if (old.busy) continue
      old.session.destroy()
      this.kept.delete(id)
    }
  }

  /** Closes a thread's session, unless a step is using it. */
  private drop(threadId: string) {
    const kept = this.kept.get(threadId)
    if (!kept || kept.busy) return
    kept.session.destroy()
    this.kept.delete(threadId)
  }

  /** A session for this call, holding the system prompt, that reports an overflow. */
  private async session(
    options: TextOptions<PromptApiTextModelOptions>,
    system: string,
    signal: AbortSignal | undefined
  ): Promise<LanguageModelSession> {
    const { samplingMode, temperature, topK } = options.modelOptions ?? {}
    const session = await createSession(
      {
        ...baseOptions(this.languages, mediaIn(options.messages)),
        ...(system && { initialPrompts: [{ role: "system", content: system }] }),
        ...(samplingMode !== undefined && { samplingMode }),
        ...(temperature !== undefined && { temperature }),
        ...(topK !== undefined && { topK })
      },
      signal,
      this.onDownloadProgress
    )
    if (this.onContextOverflow) session.addEventListener("contextoverflow", this.onContextOverflow)
    return session
  }

  /**
   * The step's session and the messages to prompt it with: the thread's
   * kept session if the conversation goes on from what it holds (only the
   * new messages), else a new one with the whole conversation. A second step
   * on a busy thread gets a session of its own (`kept` undefined).
   */
  private async begin(options: TextOptions<PromptApiTextModelOptions>, signal: AbortSignal | undefined) {
    const { threadId } = options
    const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
    const { system, settings } = sessionSettings(options, tools)
    const keys = options.messages.map(messageKey)
    const held = this.kept.get(threadId)
    const goesOn = !!held && goesOnFrom(held, settings, keys)
    const input = await toLanguageModelMessages(options.messages, goesOn ? held.seen.length : 0)
    let kept: Kept | undefined
    let session: LanguageModelSession
    if (goesOn) {
      kept = held
      session = held.session
    } else {
      this.drop(threadId)
      session = await this.session(options, system, signal)
      if (!held?.busy) kept = { session, settings, seen: [], busy: false }
    }
    if (kept) {
      kept.busy = true
      this.keep(threadId, kept)
    }
    return { session, kept, keys, input }
  }

  /** Frees a step's session: a kept one stays for the thread unless the step failed. */
  private end(threadId: string, session: LanguageModelSession | undefined, kept: Kept | undefined, failed: boolean) {
    if (!kept) return session?.destroy()
    kept.busy = false
    if (failed) this.drop(threadId)
  }

  async *chatStream(options: TextOptions<PromptApiTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const { threadId } = options
    const messageId = nextId("msg")
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

    let step: Awaited<ReturnType<typeof this.begin>> | undefined
    let failed = false
    // Stops the generation once a tool call is read.
    const stop = new AbortController()
    try {
      step = await this.begin(options, signal)
      const { session, kept, keys, input } = step
      const reader = toolCallReader()
      let text = ""
      const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        if (!text) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
        text += delta
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content: text, model, timestamp: timestamp() }
      }
      const generation = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      try {
        for await (const piece of session.promptStreaming(input, { signal: generation })) {
          yield* textEvents(reader.push(piece))
          if (reader.call) {
            stop.abort()
            break
          }
        }
      } catch (error) {
        if (!stop.signal.aborted || signal?.aborted) throw error
      }
      yield* textEvents(reader.end())
      const call = reader.call
      // Text after the call, in the piece that closed it, is shown too.
      yield* textEvents(reader.trailing)
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      // A finished reply is in the session now. One stopped at a tool call
      // isn't: Chrome drops a stopped turn whole, so the next step sends it.
      if (kept && !stop.signal.aborted) kept.seen = [...keys, messageKey({ role: "assistant", content: text })]
      if (call) {
        const toolCallId = nextId("call")
        const args = JSON.stringify(call.arguments)
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: call.name,
          parentMessageId: messageId,
          index: 0,
          model,
          timestamp: timestamp()
        }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args, args, model, timestamp: timestamp() }
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId,
          toolCallName: call.name,
          args,
          input: call.arguments,
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
        finishReason: call ? "tool_calls" : "stop"
      }
    } catch (error) {
      // An abort keeps the thread's session: Chrome drops the stopped turn.
      const aborted = !!signal?.aborted
      failed = !aborted
      options.logger.errors("prompt-api chatStream failed", { error, source: "prompt-api.chatStream" })
      const message = error instanceof Error ? error.message : String(error)
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: timestamp(),
        message,
        error: { message, ...(aborted && { code: "aborted" }) }
      }
    } finally {
      this.end(threadId, step?.session, step?.kept, failed)
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`: the thread's session
   * answers the conversation under the Prompt API's `responseConstraint`,
   * which holds the model to the schema as given. `chat()` validates the
   * result.
   */
  async structuredOutput(
    options: StructuredOutputOptions<PromptApiTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    let step: Awaited<ReturnType<typeof this.begin>> | undefined
    let failed = false
    try {
      step = await this.begin(chatOptions, signal)
      const { session, kept, keys, input } = step
      const rawText = await session.prompt(input, { responseConstraint: outputSchema, signal })
      if (kept) kept.seen = [...keys, messageKey({ role: "assistant", content: rawText })]
      const data = JSON.parse(rawText) as unknown
      return { data, rawText, model: this.model }
    } catch (error) {
      failed = true
      throw error
    } finally {
      this.end(chatOptions.threadId, step?.session, step?.kept, failed)
    }
  }
}

/**
 * A TanStack AI text adapter for the browser's built-in model, through the
 * Prompt API: Gemini Nano in Chrome, Phi-4-mini in Edge. The model is
 * whichever the browser has ("text", as other Prompt API libraries name it), so naming it is optional.
 *
 * @example
 * ```ts
 * const adapter = promptApiText()
 * if ((await adapter.availability()) !== "unavailable") {
 *   chat({ adapter, messages, tools })
 * }
 * ```
 */
export function promptApiText(config?: PromptApiConfig): PromptApiTextAdapter
export function promptApiText(model: PromptApiChatModel, config?: PromptApiConfig): PromptApiTextAdapter
export function promptApiText(
  modelOrConfig?: PromptApiChatModel | PromptApiConfig,
  config: PromptApiConfig = {}
): PromptApiTextAdapter {
  return typeof modelOrConfig === "string"
    ? new PromptApiTextAdapter(config, modelOrConfig)
    : new PromptApiTextAdapter(modelOrConfig ?? {}, "text")
}
