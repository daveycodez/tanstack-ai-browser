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
 * system prompt) starts a new one. Tools go by prompt (`tools.ts`), and a
 * call that isn't valid is repaired once under `responseConstraint`;
 * structured output prompts the thread's session under the Prompt API's own
 * `responseConstraint`.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage, Tool } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { contentText, mediaIn, toLanguageModelMessages } from "./messages.js"
import { baseOptions, createSession, DEFAULT_LANGUAGES, NO_PROMPT_API, promptApiAvailability, PromptApiError } from "./model.js"
import type { Availability, MediaInput } from "./model.js"
import type { PromptApiChatModel } from "./model-meta.js"
import { repairPrompt, repairToolCall, toolCallError, toolCallReader, toolSystemPrompt } from "./tools.js"
import { languageModel } from "./types.js"
import type {
  DownloadProgressCallback,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelSession,
  QuotaExceededError,
  SamplingMode
} from "./types.js"

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
   * messages after the system prompt to make room. A warning is logged
   * without one.
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

/** The session's size after a call, in `RUN_FINISHED`'s `usage.providerUsageDetails`. */
export type PromptApiProviderUsageDetails = {
  /** Tokens the session held after the call. */
  contextUsage: number
  /** Tokens it can hold. */
  contextWindow: number
}

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a failed call means for the user. */
function promptErrorText(error: unknown) {
  if (error instanceof PromptApiError) return error.message
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") {
      const { requested, quota, contextWindow } = error as QuotaExceededError
      const free = quota ?? contextWindow
      const sizes = requested && free !== undefined ? ` (it needs ${requested} tokens; ${free} are free)` : ""
      return `This is too long for the built-in model${sizes}. Start a new chat or send something shorter.`
    }
    if (error.name === "NotSupportedError") return `The built-in model can't do this: ${error.message}`
    if (error.name === "SecurityError") {
      return "The built-in model can't read that image: it's from another site that doesn't allow it (CORS)."
    }
    if (error.name === "EncodingError") {
      return "The built-in model can't read that image or audio: its format isn't supported."
    }
  }
  return `The built-in model failed: ${errorText(error)}`
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

/**
 * A call's token counts, measured once the model is done (so counting never
 * holds up the reply): close, not exact, as the Prompt API counts whole
 * messages.
 */
async function usageOf(session: LanguageModelSession, input: LanguageModelInput, reply: string): Promise<TokenUsage> {
  const promptTokens = await session.measureContextUsage(input)
  const completionTokens = reply ? await session.measureContextUsage(reply) : 0
  const usage = buildBaseUsage<PromptApiProviderUsageDetails>({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  })
  usage.providerUsageDetails = { contextUsage: session.contextUsage, contextWindow: session.contextWindow }
  return usage
}

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
  private readonly onContextOverflow: (event: Event) => void
  /** Each thread's session, least recently used first. */
  private readonly kept = new Map<string, Kept>()

  constructor(config: PromptApiConfig, model: PromptApiChatModel) {
    super({}, model)
    this.languages = config.languages ?? DEFAULT_LANGUAGES
    this.inputs = config.inputs ?? []
    this.onDownloadProgress = config.onDownloadProgress
    this.onContextOverflow =
      config.onContextOverflow ??
      (() => console.warn("The built-in model's context window overflowed: its oldest messages were dropped."))
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
    session.addEventListener("contextoverflow", this.onContextOverflow)
    return session
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

    let session: LanguageModelSession | undefined
    // The thread's kept session, or none when this step has one of its own.
    let kept: Kept | undefined
    // Stops the generation once a tool call is read.
    const stop = new AbortController()
    // The thread's session no longer matches its conversation.
    let discard = false
    try {
      if (!languageModel()) throw new PromptApiError(NO_PROMPT_API)
      const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
      const { system, settings } = sessionSettings(options, tools)
      const keys = options.messages.map(messageKey)
      // The thread's session goes on if the conversation goes on from what it
      // holds; anything else (an edit, new settings) starts a new one.
      const held = this.kept.get(threadId)
      const goesOn = !!held && goesOnFrom(held, settings, keys)
      const start = goesOn ? held.seen.length : 0
      const input = await toLanguageModelMessages(options.messages, start)
      if (input.length === 0) throw new PromptApiError("There's no message for the built-in model to answer.")
      if (goesOn) {
        kept = held
      } else {
        this.drop(threadId)
        session = await this.session(options, system, signal)
        // A second step on a busy thread gets a session of its own.
        if (!held?.busy) kept = { session, settings, seen: [], busy: false }
      }
      if (kept) {
        session = kept.session
        kept.busy = true
        this.keep(threadId, kept)
      }
      if (!session) throw new PromptApiError("The built-in model's session didn't start.")

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
          if (reader.fence !== undefined) {
            stop.abort()
            break
          }
        }
      } catch (error) {
        if (!stop.signal.aborted || signal?.aborted) throw error
      }
      yield* textEvents(reader.end())
      // A finished reply is in the session now. One stopped at a tool call
      // isn't: Chrome drops a stopped turn whole, so the next step sends it.
      const finished = !stop.signal.aborted

      let call = reader.call
      const fence = reader.fence
      const reason = fence === undefined ? undefined : toolCallError(call, tools)
      if (fence !== undefined && reason !== undefined) {
        // One repair, held to the schema, on a copy of the session: the
        // failed attempt and the repair prompt stay out of the thread's.
        const attempt: Array<LanguageModelMessage> = [
          ...(finished ? [] : [...input, { role: "assistant" as const, content: text + fence }]),
          { role: "user", content: repairPrompt(reason) }
        ]
        const base = session
        call = await repairToolCall(tools, call?.name, async (schema) => {
          const copy = await base.clone({ signal })
          try {
            return JSON.parse(await copy.prompt(attempt, { responseConstraint: schema, signal })) as unknown
          } finally {
            copy.destroy()
          }
        })
        signal?.throwIfAborted()
        // If it fails too (a schema Chrome can't enforce included), the fence is text.
        if (!call) yield* textEvents(fence)
        // A finished reply holds the failed call, not the repaired one: the
        // session starts over next step.
        else if (finished) discard = true
      }
      // Text after the call, in the piece that closed it, is shown too.
      yield* textEvents(reader.trailing)
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      if (kept && finished) kept.seen = [...keys, messageKey({ role: "assistant", content: text })]
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
        finishReason: call ? "tool_calls" : "stop",
        usage: await usageOf(session, input, text)
      }
    } catch (error) {
      // An abort ends the stream quietly, as with TanStack's other adapters.
      // (Chrome drops the stopped turn, so the thread's session stays good.)
      if (signal?.aborted) return
      // A session that failed isn't kept.
      if (kept) {
        kept.busy = false
        this.drop(threadId)
        kept = undefined
        session = undefined
      }
      options.logger.errors("prompt-api chatStream failed", { error, source: "prompt-api.chatStream" })
      const message = promptErrorText(error)
      yield { type: EventType.RUN_ERROR, runId, model, timestamp: timestamp(), message, error: { message } }
    } finally {
      if (kept) {
        kept.busy = false
        if (discard) this.drop(threadId)
      } else session?.destroy()
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
    const { threadId } = chatOptions
    const signal = signalOf(chatOptions)
    let session: LanguageModelSession | undefined
    let kept: Kept | undefined
    try {
      if (!languageModel()) throw new PromptApiError(NO_PROMPT_API)
      const tools = chatOptions.toolChoice === "none" ? [] : (chatOptions.tools ?? [])
      const { system, settings } = sessionSettings(chatOptions, tools)
      const keys = chatOptions.messages.map(messageKey)
      const held = this.kept.get(threadId)
      const goesOn = !!held && goesOnFrom(held, settings, keys)
      const input = await toLanguageModelMessages(chatOptions.messages, goesOn ? held.seen.length : 0)
      if (goesOn) {
        kept = held
      } else {
        this.drop(threadId)
        session = await this.session(chatOptions, system, signal)
        if (!held?.busy) kept = { session, settings, seen: [], busy: false }
      }
      if (kept) {
        session = kept.session
        kept.busy = true
        this.keep(threadId, kept)
      }
      if (!session) throw new PromptApiError("The built-in model's session didn't start.")
      const prompt = input.length > 0 ? input : "Answer."
      const rawText = await session.prompt(prompt, { responseConstraint: outputSchema, signal })
      if (kept) kept.seen = [...keys, messageKey({ role: "assistant", content: rawText })]
      let data: unknown
      try {
        data = JSON.parse(rawText) as unknown
      } catch (error) {
        throw new Error(`The model's answer isn't JSON: ${rawText.slice(0, 200)}`, { cause: error })
      }
      return { data, rawText, model: this.model, usage: await usageOf(session, prompt, rawText) }
    } catch (error) {
      // A session that failed isn't kept.
      if (kept) {
        kept.busy = false
        this.drop(threadId)
        kept = undefined
        session = undefined
      }
      signal?.throwIfAborted()
      if (error instanceof DOMException && error.name === "NotSupportedError") {
        throw new Error("The browser cannot enforce the requested JSON Schema.", { cause: error })
      }
      if (error instanceof DOMException) throw new Error(promptErrorText(error), { cause: error })
      throw error
    } finally {
      if (kept) kept.busy = false
      else session?.destroy()
    }
  }
}

/**
 * A TanStack AI text adapter for the browser's built-in model, through the
 * Prompt API: Gemini Nano in Chrome, Phi-4-mini in Edge.
 *
 * @example
 * ```ts
 * const adapter = promptApiText("built-in")
 * if ((await adapter.availability()) !== "unavailable") {
 *   chat({ adapter, messages, tools })
 * }
 * ```
 */
export function promptApiText(model: PromptApiChatModel, config: PromptApiConfig = {}): PromptApiTextAdapter {
  return new PromptApiTextAdapter(config, model)
}
