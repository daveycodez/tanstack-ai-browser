import { draftReasoning, promptReasoningOptions, withWorkingNotes } from "./reasoning.js"
import type { PromptApiReasoning, PromptApiReasoningUsage } from "./reasoning.js"
import { calibrationSample, internalAbort, outputLimitUsage, outputTokenLimit, parallelToolCalls, textOfInput, tokenLimiter } from "./limit.js"
import type { PromptApiOutputLimitUsage } from "./limit.js"
/**
 * A TanStack AI text adapter for the browser's built-in language model,
 * through the Prompt API (`LanguageModel`): Gemini Nano in Chrome,
 * Phi-4-mini in Edge. The browser downloads and runs the model itself;
 * nothing leaves the device. Hand it to `chat()` like any hosted model's
 * adapter: `chat()` runs tools and the agent loop, and each `chatStream`
 * call here is one step of the model, streamed back as AG-UI events.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type {
  AdapterYieldChunk,
  ModelMessage,
  TextOptions,
  TokenUsage,
  Tool
} from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type {
  StructuredOutputOptions,
  StructuredOutputResult
} from "@tanstack/ai/adapters"

import {
  assistantMessage,
  mediaIn,
  toLanguageModelMessages,
  toPromptMessages
} from "./messages.js"
import type { PromptMessage } from "./messages.js"
import {
  baseOptions,
  DEFAULT_LANGUAGES,
  loadPromptApiModel,
  NO_PROMPT_API,
  promptApiAvailability,
  PromptApiError
} from "./model.js"
import type { Availability, MediaInput } from "./model.js"
import { destroyPromptApiSessions, leaseSession } from "./sessions.js"
import type { Lease } from "./sessions.js"
import {
  decisionSchema,
  inputSchemaOf,
  noNativeTools,
  parseArguments,
  parseDecision,
  supportsNativeTools,
  toLanguageModelTools,
  toolCallText,
  toolsPrompt
} from "./tools.js"
import { languageModel } from "./types.js"
import type {
  LanguageModelContent,
  LanguageModelCreateOptions,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelOutput,
  LanguageModelSession,
  LanguageModelToolCall,
  QuotaExceededError,
  SamplingMode
} from "./types.js"

import type { PromptApiChatModel } from "./model-meta.js"

export type PromptApiConfig = {
  /**
   * Languages the conversation is in, input and output: ["en"] by default.
   * Chrome's model takes "en", "es", "ja", "de" and "fr", and checks its
   * safety filters for the output language.
   */
  languages?: ReadonlyArray<string>
  /**
   * Whether to use the browser's own tool use where it has it (the spec's
   * open-loop tool use, which Chrome doesn't ship to web pages yet): true
   * by default. Off, or where the browser lacks it, tools go through guided
   * generation. A specific `toolChoice` always does.
   */
  nativeTools?: boolean
  /**
   * Kinds of input besides text the conversation will have ("image",
   * "audio"), for `availability()`: images need more of the device, audio a
   * GPU. Text only by default. Sessions expect what each conversation has.
   */
  inputs?: ReadonlyArray<MediaInput>
  /**
   * The browser's download of its model, 0 to 1, when a call (`chat()`,
   * say) starts it; then 1 once the first session starts. To download it
   * ahead of time with progress, see `createSessionWithProgress`.
   */
  onDownloadProgress?: (progress: number) => void
}

/**
 * Per-call `modelOptions`. A session's sampling is set when it starts, so a
 * change starts a new session.
 */
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
  /**
   * The most tokens the reply may have, emulated reasoning's working notes
   * included (as OpenAI and OpenRouter count reasoning). The Prompt API has
   * no output cap, so the adapter estimates the reply's tokens as it streams
   * (Chrome can't count while the model writes), stops it a little past the
   * cap, and trims it exactly to the cap with the session's tokenizer once
   * it has stopped: best-effort.
   */
  maxCompletionTokens?: number
  /**
   * False keeps only the first tool call of a reply. Only the browser's own
   * tool use can write several; guided tool calls are always one per step.
   */
  parallelToolCalls?: boolean
}

/**
 * Timings of one model call, in milliseconds, and the session's size, in
 * `RUN_FINISHED`'s `usage.providerUsageDetails`.
 */
export type PromptApiProviderUsageDetails = {
  /** From the call to the first generated text, deciding on tools included. */
  firstTokenMs?: number
  /** Reading the prompt: starting a session or appending to it, to the first text. */
  promptMs?: number
  /** From the first generated text to the last. */
  decodeMs?: number
  /**
   * Tokens generated after the first one, over `decodeMs`: an estimate (the
   * Prompt API counts tokens for a whole message, not as they're written).
   */
  decodeTokens?: number
  /** Tokens the session holds after the call. */
  contextUsage?: number
  /** Tokens it can hold. */
  contextWindow?: number
  /** True when the browser dropped the oldest turns to make room during the call. */
  contextOverflow?: boolean
  reasoningEmulated?: true
  reasoningTokenMeasurement?: "context-usage"
  reasoningBudgetEnforcement?: "best-effort"
  thinkingTokens?: number
  thinkingBudgetTokens?: number
  thinkingBudgetExhausted?: boolean
  reasoningMs?: number
} & Partial<PromptApiOutputLimitUsage>


type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** What a failed prompt means for the user. */
function promptErrorText(error: unknown) {
  if (error instanceof PromptApiError) return error.message
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") {
      const { requested, quota, contextWindow } = error as QuotaExceededError
      const free = quota ?? contextWindow
      const sizes =
        requested && free !== undefined
          ? ` (it needs ${requested} tokens; ${free} are free)`
          : ""
      return `This is too long for the built-in model${sizes}. Start a new chat or send something shorter.`
    }
    if (error.name === "NotSupportedError") {
      return `The built-in model can't do this: ${error.message}`
    }
    if (error.name === "SecurityError") {
      return "The built-in model can't read that image: it's from another site that doesn't allow it (CORS)."
    }
    if (error.name === "EncodingError") {
      return "The built-in model can't read that image or audio: its format isn't supported."
    }
  }
  return `The built-in model failed: ${errorText(error)}`
}

/** Whether an error is the browser refusing a session with tools. */
function refusedTools(error: unknown) {
  const cause = error instanceof PromptApiError ? error.cause : error
  return (
    cause instanceof TypeError ||
    (cause instanceof DOMException && cause.name === "NotSupportedError")
  )
}

/** A model call's token counts as TanStack AI usage, with its timings. */
function usageOf(
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  details: PromptApiProviderUsageDetails
): TokenUsage {
  const usage = buildBaseUsage<PromptApiProviderUsageDetails>({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  })
  if (cachedTokens > 0) usage.promptTokensDetails = { cachedTokens }
  usage.providerUsageDetails = details
  return usage
}

/**
 * Tokens of what the model wrote, measured once it's done (so the count
 * never holds up the reply). The rest of the session is the prompt.
 */
/**
 * Prompt tokens of a call whose generation was stopped at the output cap:
 * what the session held before, plus the input (an aborted prompt leaves
 * the session's own count unspecified).
 */
const promptTokensBefore = async (
  session: LanguageModelSession,
  contextBefore: number,
  input: LanguageModelInput,
  signal: AbortSignal | undefined
) => contextBefore + (await session.measureContextUsage(input, ...(signal ? [{ signal }] : [])))

const CAP_REACHED = "maxCompletionTokens reached"

/** What measureContextUsage counts for an empty message: its framing, per session. */
const framing = new WeakMap<LanguageModelSession, Promise<number>>()

/**
 * A reply's tokens: its measured text less a message's framing, which
 * measureContextUsage counts too (as the output cap's measurement does).
 */
const replyTokens = async (session: LanguageModelSession, text: string, signal?: AbortSignal) => {
  if (!text) return 0
  const options = signal ? [{ signal }] : []
  try {
    let empty = framing.get(session)
    if (!empty) {
      empty = session.measureContextUsage("", ...options)
      framing.set(session, empty)
      empty.catch(() => framing.delete(session))
    }
    return Math.max(0, (await session.measureContextUsage(text, ...options)) - (await empty))
  } catch {
    signal?.throwIfAborted()
    return 0
  }
}

/** A prompt's reply as text, from a session that may answer in pieces. */
const textOf = (output: LanguageModelOutput) =>
  typeof output === "string"
    ? output
    : output
        .map((part) => (part.type === "text" ? String(part.value) : ""))
        .join("")

/** A streamed chunk's pieces: a text delta, or pieces with tool calls. */
const piecesOf = (
  chunk: string | LanguageModelContent | Array<LanguageModelContent>
): Array<LanguageModelContent> =>
  typeof chunk === "string"
    ? [{ type: "text", value: chunk }]
    : Array.isArray(chunk)
      ? chunk
      : [chunk]

/**
 * The tool calls of the current turn (since the last user message), as
 * the model writes them, to catch the model calling one again.
 */
function currentTurnCalls(messages: ReadonlyArray<ModelMessage>) {
  const start = messages.map((m) => m.role).lastIndexOf("user")
  return new Set(
    messages
      .slice(start + 1)
      .flatMap((m) => m.toolCalls ?? [])
      .map((call) =>
        toolCallText(
          call.function.name,
          parseArguments(call.function.arguments) ?? {}
        )
      )
  )
}

/** The conversation split where the model last spoke. */
function splitAtLastReply(conversation: Array<PromptMessage>) {
  const lastReply = conversation.map((m) => m.role).lastIndexOf("assistant")
  return {
    prior: conversation.slice(0, lastReply + 1),
    input: conversation.slice(lastReply + 1)
  }
}

let ids = 0
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** Where a chunk came from, in `metadata.tanstack.source`. */
type ChunkSource = { provider: string; api: string; model: string }

const sourceOf = (
  adapter: { provider: string; api: string; model: string },
  model: string | undefined
): ChunkSource => ({
  provider: adapter.provider,
  api: adapter.api,
  model: model ?? adapter.model
})

/** A chunk tagged with its source, as TanStack's own adapters tag theirs. */
function withSource(chunk: AdapterYieldChunk, source: ChunkSource): AdapterYieldChunk {
  const metadata = chunk.metadata as Record<string, unknown> | undefined
  return {
    ...chunk,
    metadata: {
      ...metadata,
      tanstack: {
        ...(metadata?.tanstack as Record<string, unknown> | undefined),
        source
      }
    }
  }
}

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions<PromptApiTextModelOptions>) =>
  options.abortController?.signal ??
  (options.request as RequestInit | undefined)?.signal ??
  undefined

/** A structured answer that failed, with the `RUN_ERROR` code it streams as. */
class StructuredOutputFailure extends Error {
  constructor(
    message: string,
    readonly code: "parse-error" | "empty-response" | "unsupported-schema" | "max_tokens",
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "StructuredOutputFailure"
  }
}

/** A structured answer, with the emulated reasoning written before it. */
type StructuredRunResult = StructuredOutputResult<unknown> & {
  reasoning?: string
}

/** A call's session and what it reads. */
type Prepared = {
  lease: Lease
  prior: Array<PromptMessage>
  inputMessages: Array<PromptMessage>
  input: Array<LanguageModelMessage>
}

export class PromptApiTextAdapter extends BaseTextAdapter<
  PromptApiChatModel,
  PromptApiTextModelOptions,
  readonly ["text", "image", "audio"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  PromptApiReasoning
> {
  override readonly kind = "text" as const
  readonly name = "prompt-api" as const
  override readonly provider = "prompt-api" as const
  override readonly api = "prompt-api" as const
  override readonly inputModalities = ["text", "image", "audio"] as const
  private readonly languages: ReadonlyArray<string>
  private readonly nativeTools: boolean
  private readonly inputs: ReadonlyArray<MediaInput>
  private readonly onDownloadProgress: ((progress: number) => void) | undefined

  constructor(config: PromptApiConfig, model: PromptApiChatModel) {
    super({}, model)
    this.languages = config.languages ?? DEFAULT_LANGUAGES
    this.nativeTools = config.nativeTools ?? true
    this.inputs = config.inputs ?? []
    this.onDownloadProgress = config.onDownloadProgress
  }

  /**
   * The browser's own `LanguageModel.availability()` for this adapter's
   * `languages` and `inputs`: "available" (on the device), "downloadable"
   * or "downloading" (it downloads when a session starts, or at
   * `createSessionWithProgress`), or "unavailable" (no Prompt API, as on a
   * server or in a browser without it, or the device can't run it).
   */
  availability(): Promise<Availability> {
    return promptApiAvailability(this.languages, { inputs: this.inputs })
  }

  /**
   * Downloads the browser's model if it isn't on the device, and starts it,
   * with the download's progress, 0 to 1, then 1 once it's ready. Resolves
   * to this adapter then; rejects if it can't start (fine to leave
   * unawaited). `chat()` doesn't need it (its first session does the same),
   * but the browser asks for a click on the page before a download: call it
   * from the click that turns the model on. Aborting `signal` rejects this
   * call at once with an AbortError and stops its progress reports; the
   * browser's `LanguageModel.create()` (and its download) is aborted when
   * no other call still waits on it.
   */
  createSessionWithProgress(
    onDownloadProgress?: (progress: number) => void,
    options: { signal?: AbortSignal } = {}
  ): Promise<this> {
    const own = this.onDownloadProgress
    const ready = loadPromptApiModel({
      languages: this.languages,
      ...(options.signal && { signal: options.signal }),
      onDownloadProgress:
        own && onDownloadProgress
          ? (progress) => {
              own(progress)
              onDownloadProgress(progress)
            }
          : (own ?? onDownloadProgress)
    }).then(() => this)
    // Callers may leave it: an unawaited failure isn't an unhandled rejection.
    ready.catch(() => undefined)
    return ready
  }

  /**
   * Frees every session the adapters keep, as when the page no longer needs
   * the model (they share them). Sessions a call holds or is still creating
   * finish that call and are freed when it ends, not kept. The browser
   * keeps the model itself.
   */
  async destroySession(): Promise<void> {
    destroyPromptApiSessions()
  }

  /**
   * Session options: text in the languages set, the conversation's images
   * and audio, the browser's own tools if it runs them, and any sampling.
   */
  private createOptions(
    modelOptions: PromptApiTextModelOptions | undefined,
    {
      media,
      tools
    }: { media: ReadonlyArray<MediaInput>; tools?: ReadonlyArray<Tool> }
  ): LanguageModelCreateOptions {
    const { samplingMode, temperature, topK } = modelOptions ?? {}
    return {
      ...baseOptions(this.languages, { media, nativeTools: !!tools }),
      ...(tools && { tools: toLanguageModelTools(tools) }),
      ...(samplingMode !== undefined && { samplingMode }),
      ...(temperature !== undefined && { temperature }),
      ...(topK !== undefined && { topK })
    }
  }

  /** The session for a call, having read everything before its input. */
  private async prepare(
    options: TextOptions<PromptApiTextModelOptions>,
    tools: Array<Tool>,
    native: boolean,
    signal: AbortSignal | undefined
  ): Promise<Prepared> {
    const conversation = toPromptMessages(options.messages, {
      nativeTools: native
    })
    // What's new since the model's last message is this call's input; the
    // rest, a session may have read already.
    const { prior, input: inputMessages } = splitAtLastReply(conversation)
    if (inputMessages.length === 0) {
      throw new PromptApiError(
        "There's no message for the built-in model to answer."
      )
    }
    const system = [
      ...normalizeSystemPrompts(options.systemPrompts).map((p) => p.content),
      ...(tools.length > 0 && !native ? [toolsPrompt(tools)] : [])
    ].join("\n\n")
    const media = new Map<string, Promise<Blob>>()
    const reasoningEnabled = promptReasoningOptions(options.reasoning).enabled
    const lease = await leaseSession({
      threadId: reasoningEnabled ? undefined : options.promptCache?.key ?? options.threadId,
      ...(reasoningEnabled || options.promptCache?.retention === "none" ? { retain: false } : {}),
      system,
      prior,
      options: this.createOptions(options.modelOptions, {
        media: mediaIn(conversation),
        tools: native ? tools : undefined
      }),
      signal,
      media,
      onDownloadProgress: this.onDownloadProgress
    })
    if (lease.miss) {
      options.logger.provider(
        `provider=prompt-api new session: ${lease.miss}`,
        { threadId: options.threadId }
      )
    }
    try {
      const input = await toLanguageModelMessages(inputMessages, media)
      return { lease, prior, inputMessages, input }
    } catch (error) {
      lease.discard()
      throw error
    }
  }

  /** The session's size, and whether it dropped old turns, for usage. */
  private sessionDetails(
    lease: Lease,
    threadId: string | undefined,
    logger: TextOptions["logger"]
  ): PromptApiProviderUsageDetails {
    const overflowed = lease.overflowed()
    if (overflowed) {
      logger.provider(
        "provider=prompt-api context overflow: the oldest turns were dropped",
        { threadId }
      )
    }
    return {
      contextUsage: lease.session.contextUsage,
      contextWindow: lease.session.contextWindow,
      ...(overflowed && { contextOverflow: true })
    }
  }

  async *chatStream(
    options: TextOptions<PromptApiTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.model)
    for await (const chunk of this.chatStreamRequest(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *chatStreamRequest(
    options: TextOptions<PromptApiTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const threadId = options.threadId
    const messageId = nextId("msg")
    const model = this.model
    const { logger } = options
    const signal =
      options.abortController?.signal ??
      (options.request as RequestInit | undefined)?.signal ??
      undefined
    const timestamp = () => Date.now()
    const runError = (message: string): AdapterYieldChunk => ({
      type: EventType.RUN_ERROR,
      runId,
      model,
      timestamp: timestamp(),
      message,
      error: { message }
    })
    const toolCallEvents = (
      toolCallId: string,
      name: string,
      input: Record<string, unknown>,
      index: number
    ): Array<AdapterYieldChunk> => {
      const args = JSON.stringify(input)
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: name,
          parentMessageId: messageId,
          index,
          model,
          timestamp: timestamp()
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: args,
          args,
          model,
          timestamp: timestamp()
        },
        {
          type: EventType.TOOL_CALL_END,
          toolCallId,
          toolCallName: name,
          args,
          input,
          model,
          timestamp: timestamp()
        }
      ]
    }
    const reasoning = promptReasoningOptions(options.reasoning)
    const limit = outputTokenLimit(options.modelOptions)
    const parallel = parallelToolCalls(options.modelOptions)
    const startedAt = performance.now()

    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }
    if (!languageModel()) {
      yield runError(NO_PROMPT_API)
      return
    }

    const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
    const choice = options.toolChoice
    let native =
      tools.length > 0 &&
      this.nativeTools &&
      (choice === undefined || choice === "auto") &&
      (await supportsNativeTools(this.languages))
    logger.request(
      `activity=chat provider=prompt-api model=${model} messages=${options.messages.length} tools=${tools.length} nativeTools=${native} stream=true`,
      { provider: "prompt-api", model }
    )

    // A kept session the browser destroyed (it shows only once used) is
    // replaced once, if nothing was sent yet.
    let retried = false
    for (;;) {
      let prepared: Prepared
      for (;;) {
        try {
          prepared = await this.prepare(options, tools, native, signal)
          break
        } catch (error) {
          if (signal?.aborted) return
          if (native && refusedTools(error)) {
            // The browser said it runs tools, then refused a session with them.
            logger.provider("provider=prompt-api native tools refused", {
              error
            })
            noNativeTools(this.languages)
            native = false
            continue
          }
          logger.errors("prompt-api session failed", {
            error,
            source: "prompt-api.chatStream"
          })
          yield runError(promptErrorText(error))
          return
        }
      }
      const { lease, prior, inputMessages } = prepared
      let input = prepared.input
      const { session } = lease
      let reasoningUsage: PromptApiReasoningUsage | undefined
      let draftCapReached = false
      // Given back only once the call has ended well; freed otherwise (an
      // abort, an error, or the stream left unread).
      let released = false
      let sent = false

      try {
        if (reasoning.enabled) {
          const draft = draftReasoning(session, input, signal, reasoning.budget, limit)
          let next = await draft.next()
          let opened = false
          const reasoningId = nextId("reasoning")
          try {
            while (!next.done) {
              if (!opened) {
                opened = true
                yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
                yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
              }
              yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: next.value, model, timestamp: timestamp() }
              next = await draft.next()
            }
            reasoningUsage = next.value.usage
            draftCapReached = next.value.capReached
            input = withWorkingNotes(input, next.value.notes) as Array<LanguageModelMessage>
          } finally {
            if (!next.done) await draft.return({ notes: "", usage: { reasoningEmulated: true, reasoningTokenMeasurement: "context-usage", reasoningBudgetEnforcement: "best-effort", thinkingTokens: 0, thinkingBudgetExhausted: false, reasoningMs: 0 }, capReached: false })
          }
          if (opened) {
            yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
            yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
          }
        }
        signal?.throwIfAborted()
        // The cap covers the working notes and the answer together.
        const answerLimit =
          limit === undefined
            ? undefined
            : draftCapReached
              ? 0
              : Math.max(0, limit - (reasoningUsage?.thinkingTokens ?? 0))
        const call =
          answerLimit === 0
            ? "length"
            : tools.length > 0 && !native
              ? await this.decideToolCall(session, input, tools, options, signal, answerLimit)
              : undefined

        if (call === "length") {
          // No room left under the cap (or a tool call's arguments were cut
          // off by it, and no partial call is sent): nothing is written. The
          // session itself has read nothing new.
          const promptTokens = await promptTokensBefore(session, session.contextUsage, input, signal)
          const sessionDetails = this.sessionDetails(lease, threadId, logger)
          lease.release(prior)
          released = true
          yield {
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            model,
            timestamp: timestamp(),
            finishReason: "length",
            usage: usageOf(promptTokens, 0, lease.cachedTokens, {
              ...reasoningUsage,
              ...outputLimitUsage(limit, true),
              ...sessionDetails
            })
          }
          return
        }

        if (call) {
          const callText = toolCallText(call.name, call.args)
          // The session reads the step as the next request will send it.
          await session.append(
            [...input, { role: "assistant", content: callText }],
            { signal }
          )
          const decidedAt = performance.now()
          const toolCallId = nextId("tool")
          const completionTokens = await replyTokens(session, callText, signal)
          const measuredContext = session.contextUsage
          const sessionDetails = this.sessionDetails(lease, threadId, logger)
          lease.release([
            ...prior,
            ...inputMessages,
            { role: "assistant", content: callText }
          ])
          released = true
          yield* toolCallEvents(toolCallId, call.name, call.args, 0)
          yield {
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            model,
            timestamp: timestamp(),
            finishReason: "tool_calls",
            usage: usageOf(
              measuredContext - completionTokens,
              completionTokens,
              lease.cachedTokens,
              {
                ...reasoningUsage,
                ...outputLimitUsage(limit, false),
                firstTokenMs: decidedAt - startedAt,
                ...sessionDetails
              }
            )
          }
          return
        }

        // The answer, streamed as the model writes it; with the browser's
        // own tools, its tool calls come after any text. Under a cap, a
        // limiter estimates it (nothing is measured mid-stream: Chrome would
        // wait for the reply to finish), an internal abort stops it a little
        // past the cap, and the text is trimmed exactly once it has stopped.
        const promptAt = performance.now()
        const contextBefore = session.contextUsage
        let first = 0
        let last = 0
        let text = ""
        let written: Array<LanguageModelToolCall> = []
        // Calls the model wrote that aren't sent (parallelToolCalls: false).
        let dropped = false
        const limiter =
          answerLimit === undefined
            ? undefined
            : await tokenLimiter(
                session,
                answerLimit,
                calibrationSample([
                  textOfInput(input),
                  ...prior.slice().reverse().map((m) => textOfInput([m]))
                ]),
                signal
              )
        const stopper = limiter ? internalAbort(signal, CAP_REACHED) : undefined
        const textEvents = (delta: string): Array<AdapterYieldChunk> => {
          const events: Array<AdapterYieldChunk> = []
          last = performance.now()
          if (!first) {
            first = last
            sent = true
            events.push({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
              model,
              timestamp: timestamp()
            })
          }
          text += delta
          events.push({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta,
            content: text,
            model,
            timestamp: timestamp()
          })
          return events
        }
        try {
          for await (const chunk of session.promptStreaming(input, {
            signal: stopper?.signal ?? signal
          })) {
            for (const piece of piecesOf(chunk)) {
              if (piece.type === "tool-call") {
                const toolCall = piece.value as LanguageModelToolCall
                if (parallel === false && written.length > 0) {
                  dropped = true
                  continue
                }
                limiter?.account(`\n${toolCallText(toolCall.name, toolCall.arguments ?? {})}`)
                written.push(toolCall)
                continue
              }
              if (piece.type !== "text" || typeof piece.value !== "string")
                continue
              const delta = limiter ? limiter.push(piece.value) : piece.value
              if (delta) yield* textEvents(delta)
            }
            if (limiter?.stopped) {
              stopper?.stop()
              break
            }
          }
        } catch (error) {
          // The internal abort at the cap ends the stream; the caller's doesn't.
          if (!limiter?.stopped || signal?.aborted) throw error
        } finally {
          stopper?.dispose()
        }
        let cut = false
        if (limiter && answerLimit !== undefined) {
          // The generation has stopped, so the model is idle and measuring
          // is instant: the exact trim, then the text held back up to it.
          signal?.throwIfAborted()
          const kept = await limiter.finish()
          if (kept.held) yield* textEvents(kept.held)
          cut = kept.reached
          if (written.length > 0) {
            // A call counts whole: one the cap cuts into is left out, as a
            // cut-off call is with the other adapters. Calls come after the
            // text, so a trim inside the text leaves none.
            let fits = 0
            while (!kept.trimmed && fits < written.length) {
              const reply = [kept.text, ...written.slice(0, fits + 1).map((c) => toolCallText(c.name, c.arguments ?? {}))]
                .filter(Boolean)
                .join("\n")
              if ((await limiter.measure(reply)) > answerLimit) break
              fits++
            }
            if (fits < written.length) {
              written = written.slice(0, fits)
              cut = true
            }
          }
        }
        if (first) {
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
            model,
            timestamp: timestamp()
          }
        }
        const calls = written.map((c) => ({
          callId: c.callId || nextId("tool"),
          name: c.name,
          arguments: c.arguments ?? {}
        }))
        const completionTokens = await replyTokens(
          session,
          [text, ...calls.map((c) => toolCallText(c.name, c.arguments))]
            .filter(Boolean)
            .join("\n")
        )
        const reply = assistantMessage(text, calls, native)
        const promptTokens = cut
          ? await promptTokensBefore(session, contextBefore, input, signal)
          : session.contextUsage - completionTokens
        const sessionDetails = this.sessionDetails(lease, threadId, logger)
        // A reply stopped at the cap, or with calls left out, isn't what the
        // session read (an aborted prompt leaves its history unspecified), so
        // that session is freed rather than kept.
        if (!cut && !dropped) {
          lease.release([...prior, ...inputMessages, ...(reply ? [reply] : [])])
          released = true
        }
        for (const [index, c] of calls.entries()) {
          yield* toolCallEvents(c.callId, c.name, c.arguments, index)
        }
        yield {
          type: EventType.RUN_FINISHED,
          runId,
          threadId,
          model,
          timestamp: timestamp(),
          finishReason: calls.length > 0 ? "tool_calls" : cut ? "length" : "stop",
          usage: usageOf(
            promptTokens,
            completionTokens,
            lease.cachedTokens,
            {
              ...(first && {
                firstTokenMs: first - startedAt,
                promptMs: lease.createMs + (first - promptAt),
                decodeMs: last - first,
                decodeTokens: Math.max(completionTokens - 1, 0)
              }),
              ...reasoningUsage,
              ...outputLimitUsage(limit, cut),
              ...sessionDetails
            }
          )
        }
        return
      } catch (error) {
        if (signal?.aborted) return
        const destroyed =
          error instanceof DOMException && error.name === "InvalidStateError"
        if (destroyed && lease.reused && !sent && !retried) {
          logger.provider(
            "provider=prompt-api the kept session was destroyed; starting a new one",
            { threadId }
          )
          retried = true
          continue
        }
        logger.errors("prompt-api prompt failed", {
          error,
          source: "prompt-api.chatStream"
        })
        yield runError(promptErrorText(error))
        return
      } finally {
        if (!released) lease.discard()
      }
    }
  }

  /**
   * The tool the model calls for this input, with its arguments, or
   * undefined if it answers. Both are guided generations on copies of the
   * session, so the session itself reads only what the request will send.
   * Guided routing writes one call per step, so `parallelToolCalls` holds
   * either way. Under an output cap (`limit`), the call counts toward it
   * whole, as the reply reports it (the routing decision is the adapter's,
   * not the reply, and doesn't); a call the cap cuts off gives "length",
   * never a broken call.
   */
  private async decideToolCall(
    session: LanguageModelSession,
    input: Array<LanguageModelMessage>,
    tools: Array<Tool>,
    options: TextOptions<PromptApiTextModelOptions>,
    signal: AbortSignal | undefined,
    limit: number | undefined
  ): Promise<{ name: string; args: Record<string, unknown> } | "length" | undefined> {
    const names = tools.map((tool) => tool.name)
    const choice = options.toolChoice
    let action: string | undefined
    if (typeof choice === "object" && names.includes(choice.name)) {
      action = choice.name
    } else if (choice === "required" && tools.length === 1) {
      // The only allowed route is already known; constrain its arguments directly.
      action = names[0]
    } else {
      const { text: raw } = await promptCopy(session, input, signal, {
        responseConstraint: decisionSchema(names, choice === "required")
      })
      action = parseDecision(raw)?.action
      options.logger.provider("provider=prompt-api decision", { raw })
    }
    const tool = tools.find((t) => t.name === action)
    if (!tool) return undefined

    const schema = inputSchemaOf(tool)
    const hasFields =
      Object.keys((schema.properties ?? {}) as object).length > 0
    const generated = hasFields
      ? await promptCopy(session, input, signal, { responseConstraint: schema }, limit)
      : { text: "{}", reached: false }
    const parsed = parseArguments(generated.text)
    // Arguments that still parse were complete when the cap was reached.
    if (generated.reached && !parsed) return "length"
    const args = parsed ?? {}
    // Small models sometimes call the tool they just called, with the same
    // arguments, instead of answering from its result.
    if (currentTurnCalls(options.messages).has(toolCallText(tool.name, args))) {
      return undefined
    }
    // The call counts toward the cap as the reply reports it, whole: one that
    // doesn't fit is cut off, as the native path leaves such calls out.
    if (limit !== undefined && (await replyTokens(session, toolCallText(tool.name, args), signal)) > limit) {
      return "length"
    }
    return { name: tool.name, args }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`, from guided generation:
   * `responseConstraint` holds the model to the original schema. Unsupported
   * schemas fail explicitly rather than silently dropping constraints. `chat()`
   * validates the result. One constrained prompt, not streamed; the streamed
   * form is `structuredOutputStream`.
   */
  async structuredOutput(
    options: StructuredOutputOptions<PromptApiTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const run = this.structuredOutputRun(options, false)
    let next = await run.next()
    while (!next.done) next = await run.next()
    const { data, rawText, model, usage } = next.value
    return { data, rawText, model, ...(usage && { usage }) }
  }

  /**
   * `chat({ outputSchema, stream: true })`: the JSON streamed as the model
   * writes it under `responseConstraint`, after any emulated reasoning
   * (`REASONING_*`), then `structured-output.complete` and `RUN_FINISHED`.
   */
  async *structuredOutputStream(
    options: StructuredOutputOptions<PromptApiTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.chatOptions.model)
    for await (const chunk of this.structuredOutputRequestStream(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *structuredOutputRequestStream(
    options: StructuredOutputOptions<PromptApiTextModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const { chatOptions } = options
    const runId = chatOptions.runId ?? nextId("run")
    const threadId = chatOptions.threadId
    const messageId = nextId("msg")
    const model = this.model
    const signal = signalOf(chatOptions)
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: Date.now(),
      ...(chatOptions.parentRunId && { parentRunId: chatOptions.parentRunId })
    }
    let result: StructuredRunResult
    try {
      result = yield* this.structuredOutputRun(options, true, messageId)
    } catch (error) {
      const aborted = !!signal?.aborted
      const code = aborted
        ? "aborted"
        : error instanceof StructuredOutputFailure
          ? error.code
          : undefined
      const message = aborted
        ? errorText(signal?.reason ?? error)
        : error instanceof DOMException
          ? promptErrorText(error)
          : errorText(error)
      if (!aborted) {
        chatOptions.logger.errors("prompt-api.structuredOutputStream fatal", {
          error,
          source: "prompt-api.structuredOutputStream"
        })
      }
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: Date.now(),
        message,
        ...(code && { code }),
        error: { message, ...(code && { code }) }
      }
      return
    }
    yield {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: {
        object: result.data,
        raw: result.rawText,
        ...(result.reasoning ? { reasoning: result.reasoning } : {})
      },
      model,
      timestamp: Date.now()
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model,
      timestamp: Date.now(),
      finishReason: "stop",
      ...(result.usage && { usage: result.usage })
    }
  }

  /**
   * One structured answer: emulated reasoning (if asked for) streamed as
   * `REASONING_*` events, then the constrained JSON as `TEXT_MESSAGE_*`
   * deltas (`stream`: from `promptStreaming`; otherwise one `prompt` whose
   * whole answer is one delta). Throws on failure and cancellation, with
   * the caller's abort reason.
   */
  private async *structuredOutputRun(
    options: StructuredOutputOptions<PromptApiTextModelOptions>,
    stream: boolean,
    messageId = nextId("msg")
  ): AsyncGenerator<AdapterYieldChunk, StructuredRunResult> {
    const { chatOptions, outputSchema } = options
    const model = this.model
    const signal = signalOf(chatOptions)
    signal?.throwIfAborted()
    const reasoning = promptReasoningOptions(chatOptions.reasoning)
    const limit = outputTokenLimit(chatOptions.modelOptions)
    chatOptions.logger.request(
      `activity=${stream ? "structuredOutputStream" : "structuredOutput"} provider=prompt-api model=${model} messages=${chatOptions.messages.length}`,
      { provider: "prompt-api", model }
    )
    const conversation = toPromptMessages(chatOptions.messages, {
      nativeTools: false
    })
    const { prior, input: inputMessages } = splitAtLastReply(conversation)
    const media = new Map<string, Promise<Blob>>()
    const lease = await leaseSession({
      // Reuse the input prefix, keeping this answer on a disposable clone.
      threadId: chatOptions.promptCache?.key ?? chatOptions.threadId,
      isolated: true,
      ...(chatOptions.promptCache?.retention === "none" ? { retain: false } : {}),
      system: normalizeSystemPrompts(chatOptions.systemPrompts)
        .map((p) => p.content)
        .join("\n\n"),
      prior,
      options: this.createOptions(chatOptions.modelOptions, {
        media: mediaIn(conversation)
      }),
      signal,
      media,
      onDownloadProgress: this.onDownloadProgress
    })
    const { session } = lease
    try {
      signal?.throwIfAborted()
      let input =
        inputMessages.length > 0
          ? await toLanguageModelMessages(inputMessages, media)
          : "Answer."
      let reasoningUsage: PromptApiReasoningUsage | undefined
      let reasoningText = ""
      let draftCapReached = false
      if (reasoning.enabled) {
        const reasoningId = nextId("reasoning")
        const draft = draftReasoning(session, input, signal, reasoning.budget, limit)
        let next = await draft.next()
        try {
          while (!next.done) {
            if (!reasoningText) {
              yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: Date.now() }
              yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: Date.now() }
            }
            reasoningText += next.value
            yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: next.value, model, timestamp: Date.now() }
            next = await draft.next()
          }
          reasoningUsage = next.value.usage
          draftCapReached = next.value.capReached
          input = withWorkingNotes(input, next.value.notes)
        } finally {
          if (!next.done) await draft.return({ notes: "", usage: { reasoningEmulated: true, reasoningTokenMeasurement: "context-usage", reasoningBudgetEnforcement: "best-effort", thinkingTokens: 0, thinkingBudgetExhausted: false, reasoningMs: 0 }, capReached: false })
        }
        if (reasoningText) {
          yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: Date.now() }
          yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: Date.now() }
        }
      }
      signal?.throwIfAborted()
      // The cap covers the working notes and the JSON together.
      const answerLimit =
        limit === undefined
          ? undefined
          : draftCapReached
            ? 0
            : Math.max(0, limit - (reasoningUsage?.thinkingTokens ?? 0))
      const contextBefore = session.contextUsage
      let cut = false
      let rawText = ""
      const textStart = (): AdapterYieldChunk => ({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        model,
        timestamp: Date.now()
      })
      const textContent = (delta: string): AdapterYieldChunk => {
        rawText += delta
        return {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
          content: rawText,
          model,
          timestamp: Date.now()
        }
      }
      try {
        if (answerLimit === 0) {
          cut = true
        } else if (answerLimit !== undefined) {
          // Streamed and estimated (for `structuredOutput` too, whose answer
          // is still one delta), stopped by an internal abort a little past
          // the cap, then trimmed exactly once the model is idle.
          const limiter = await tokenLimiter(
            session,
            answerLimit,
            calibrationSample([
              textOfInput(input),
              ...prior.slice().reverse().map((m) => textOfInput([m]))
            ]),
            signal
          )
          const stopper = internalAbort(signal, CAP_REACHED)
          try {
            for await (const chunk of session.promptStreaming(input, {
              responseConstraint: outputSchema,
              signal: stopper.signal
            })) {
              for (const piece of piecesOf(chunk)) {
                if (piece.type !== "text" || typeof piece.value !== "string" || !piece.value) continue
                const delta = limiter.push(piece.value)
                if (!delta || !stream) continue
                if (!rawText) yield textStart()
                yield textContent(delta)
              }
              if (limiter.stopped) {
                stopper.stop()
                break
              }
            }
          } catch (error) {
            if (!limiter.stopped || signal?.aborted) throw error
          } finally {
            stopper.dispose()
          }
          signal?.throwIfAborted()
          const kept = await limiter.finish()
          cut = kept.reached
          // Streamed: the text held back; otherwise the whole answer, at once.
          const rest = stream ? kept.held : kept.text
          if (rest) {
            if (!rawText) yield textStart()
            yield textContent(rest)
          }
        } else if (stream) {
          for await (const chunk of session.promptStreaming(input, {
            responseConstraint: outputSchema,
            signal
          })) {
            for (const piece of piecesOf(chunk)) {
              if (piece.type !== "text" || typeof piece.value !== "string" || !piece.value) continue
              if (!rawText) yield textStart()
              yield textContent(piece.value)
            }
          }
        } else {
          const whole = textOf(
            await session.prompt(input, { responseConstraint: outputSchema, signal })
          )
          if (whole) {
            yield textStart()
            yield textContent(whole)
          }
        }
      } catch (error) {
        if (
          !rawText &&
          error instanceof DOMException &&
          error.name === "NotSupportedError"
        ) {
          throw new StructuredOutputFailure(
            "The browser cannot enforce the requested JSON Schema.",
            "unsupported-schema",
            error
          )
        }
        throw error
      }
      if (rawText) {
        yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: Date.now() }
      }
      signal?.throwIfAborted()
      const completionTokens = await replyTokens(session, rawText, signal)
      signal?.throwIfAborted()
      // Stopped at the cap: an error like the other adapters' length stop,
      // unless the JSON happened to be complete.
      const cutOff = (cause?: unknown) =>
        new StructuredOutputFailure(
          `The answer was cut off at the output token limit (maxCompletionTokens: ${limit}) before its JSON ended; raise maxCompletionTokens.`,
          "max_tokens",
          cause
        )
      if (!rawText) {
        throw cut
          ? cutOff()
          : new StructuredOutputFailure("The model's answer is empty.", "empty-response")
      }
      let data: unknown
      try {
        data = JSON.parse(rawText) as unknown
      } catch (error) {
        throw cut
          ? cutOff(error)
          : new StructuredOutputFailure(
              `The model's answer isn't JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? "…" : ""}`,
              "parse-error",
              error
            )
      }
      const promptTokens = cut
        ? await promptTokensBefore(session, contextBefore, input, signal)
        : session.contextUsage - completionTokens
      return {
        data,
        rawText,
        model,
        usage: usageOf(
          promptTokens,
          completionTokens,
          lease.cachedTokens,
          {
            ...this.sessionDetails(lease, chatOptions.threadId, chatOptions.logger),
            ...reasoningUsage,
            ...outputLimitUsage(limit, cut)
          }
        ),
        ...(reasoningText && { reasoning: reasoningText })
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof DOMException) throw new Error(promptErrorText(error), { cause: error })
      throw error
    } finally {
      lease.discard()
    }
  }
}

/**
 * A guided generation on a copy of the session, freed after. Under a
 * `limit`, it streams, estimated, stops a little past the limit, and is
 * trimmed exactly to it (`reached`).
 */
async function promptCopy(
  session: LanguageModelSession,
  input: Array<LanguageModelMessage>,
  signal: AbortSignal | undefined,
  options: { responseConstraint: object },
  limit?: number
): Promise<{ text: string; reached: boolean }> {
  const copy = await session.clone({ signal })
  try {
    if (limit === undefined) {
      return { text: textOf(await copy.prompt(input, { ...options, signal })), reached: false }
    }
    // Calibrated, and measured after, on the session: the copy generates.
    const limiter = await tokenLimiter(session, limit, calibrationSample([textOfInput(input)]), signal)
    const stopper = internalAbort(signal, CAP_REACHED)
    try {
      for await (const chunk of copy.promptStreaming(input, { ...options, signal: stopper.signal })) {
        for (const piece of piecesOf(chunk)) {
          if (piece.type === "text" && typeof piece.value === "string") limiter.push(piece.value)
        }
        if (limiter.stopped) {
          stopper.stop()
          break
        }
      }
    } catch (error) {
      if (!limiter.stopped || signal?.aborted) throw error
    } finally {
      stopper.dispose()
    }
    signal?.throwIfAborted()
    const kept = await limiter.finish()
    return { text: kept.text, reached: kept.reached }
  } finally {
    copy.destroy()
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
 *   chat({ adapter, messages, threadId })
 * }
 * ```
 */
export function promptApiText(
  model: PromptApiChatModel,
  config: PromptApiConfig = {}
): PromptApiTextAdapter {
  return new PromptApiTextAdapter(config, model)
}
