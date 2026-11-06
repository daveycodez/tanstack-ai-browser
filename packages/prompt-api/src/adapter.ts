import { draftReasoning, promptReasoningOptions, withWorkingNotes } from "./reasoning.js"
import type { PromptApiReasoning, PromptApiReasoningUsage } from "./reasoning.js"
import { internalAbort, outputLimitUsage, outputTokenLimit, parallelToolCalls, tokenMeter } from "./limit.js"
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
  NO_PROMPT_API,
  PromptApiError
} from "./model.js"
import type { MediaInput } from "./model.js"
import { leaseSession } from "./sessions.js"
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

/** The model: whichever one the browser provides. */
export type PromptApiTextModel = "built-in"

export type PromptApiTextConfig = {
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
}

/**
 * Per-call `modelOptions`. A session's sampling is set when it starts, so a
 * change starts a new session.
 */
export type PromptApiModelOptions = {
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
   * no output cap, so the adapter counts the reply as it streams and stops
   * it at the cap: best-effort, measured with the session's tokenizer.
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

const replyTokens = (session: LanguageModelSession, text: string, signal?: AbortSignal) =>
  text ? session.measureContextUsage(text, ...(signal ? [{ signal }] : [])).catch(() => {
    signal?.throwIfAborted()
    return 0
  }) : Promise.resolve(0)

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
const signalOf = (options: TextOptions<PromptApiModelOptions>) =>
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
  PromptApiTextModel,
  PromptApiModelOptions,
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

  constructor(config: PromptApiTextConfig = {}) {
    super({}, "built-in")
    this.languages = config.languages ?? DEFAULT_LANGUAGES
    this.nativeTools = config.nativeTools ?? true
  }

  /**
   * Session options: text in the languages set, the conversation's images
   * and audio, the browser's own tools if it runs them, and any sampling.
   */
  private createOptions(
    modelOptions: PromptApiModelOptions | undefined,
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
    options: TextOptions<PromptApiModelOptions>,
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
      media
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
    options: TextOptions<PromptApiModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.model)
    for await (const chunk of this.chatStreamRequest(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *chatStreamRequest(
    options: TextOptions<PromptApiModelOptions>
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
        // meter counts it and an internal abort stops it at the cap.
        const promptAt = performance.now()
        const contextBefore = session.contextUsage
        let first = 0
        let last = 0
        let text = ""
        const written: Array<LanguageModelToolCall> = []
        // Calls the model wrote that aren't sent (parallelToolCalls: false).
        let dropped = false
        const meter =
          answerLimit === undefined
            ? undefined
            : await tokenMeter(session, answerLimit, signal)
        const stopper = meter ? internalAbort(signal, CAP_REACHED) : undefined
        try {
          try {
            for await (const chunk of session.promptStreaming(input, {
              signal: stopper?.signal ?? signal
            })) {
              for (const piece of piecesOf(chunk)) {
                if (meter?.reached) break
                if (piece.type === "tool-call") {
                  const toolCall = piece.value as LanguageModelToolCall
                  if (parallel === false && written.length > 0) {
                    dropped = true
                    continue
                  }
                  if (meter) {
                    // A call counts whole: one the cap cuts into is left out,
                    // as a cut-off call is with the other adapters.
                    const whole = `${meter.text ? "\n" : ""}${toolCallText(toolCall.name, toolCall.arguments ?? {})}`
                    if ((await meter.push(whole)) !== whole) break
                  }
                  written.push(toolCall)
                  continue
                }
                if (piece.type !== "text" || typeof piece.value !== "string")
                  continue
                const delta = meter ? await meter.push(piece.value) : piece.value
                if (!delta) continue
                last = performance.now()
                if (!first) {
                  first = last
                  sent = true
                  yield {
                    type: EventType.TEXT_MESSAGE_START,
                    messageId,
                    role: "assistant",
                    model,
                    timestamp: timestamp()
                  }
                }
                text += delta
                yield {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId,
                  delta,
                  content: text,
                  model,
                  timestamp: timestamp()
                }
              }
              if (meter?.reached) {
                stopper?.stop()
                break
              }
            }
          } catch (error) {
            // The internal abort at the cap ends the stream; the caller's doesn't.
            if (!meter?.reached || signal?.aborted) throw error
          }
        } finally {
          stopper?.dispose()
          meter?.destroy()
        }
        const cut = !!meter?.reached
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
   * either way. Under an output cap (`limit`), the arguments count toward
   * it (the routing decision is the adapter's, not the reply, and doesn't);
   * arguments the cap cuts off give "length", never a broken call.
   */
  private async decideToolCall(
    session: LanguageModelSession,
    input: Array<LanguageModelMessage>,
    tools: Array<Tool>,
    options: TextOptions<PromptApiModelOptions>,
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
    options: StructuredOutputOptions<PromptApiModelOptions>
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
    options: StructuredOutputOptions<PromptApiModelOptions>
  ): AsyncIterable<AdapterYieldChunk> {
    const source = sourceOf(this, options.chatOptions.model)
    for await (const chunk of this.structuredOutputRequestStream(options)) {
      yield withSource(chunk, source)
    }
  }

  private async *structuredOutputRequestStream(
    options: StructuredOutputOptions<PromptApiModelOptions>
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
    options: StructuredOutputOptions<PromptApiModelOptions>,
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
      media
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
          // Streamed and counted (for `structuredOutput` too, whose answer is
          // still one delta), stopped by an internal abort at the cap.
          const meter = await tokenMeter(session, answerLimit, signal)
          const stopper = internalAbort(signal, CAP_REACHED)
          let whole = ""
          try {
            try {
              for await (const chunk of session.promptStreaming(input, {
                responseConstraint: outputSchema,
                signal: stopper.signal
              })) {
                for (const piece of piecesOf(chunk)) {
                  if (piece.type !== "text" || typeof piece.value !== "string" || !piece.value) continue
                  const delta = await meter.push(piece.value)
                  if (!stream) whole += delta
                  else if (delta) {
                    if (!rawText) yield textStart()
                    yield textContent(delta)
                  }
                  if (meter.reached) break
                }
                if (meter.reached) {
                  stopper.stop()
                  break
                }
              }
            } catch (error) {
              if (!meter.reached || signal?.aborted) throw error
            }
            cut = meter.reached
          } finally {
            stopper.dispose()
            meter.destroy()
          }
          if (whole) {
            yield textStart()
            yield textContent(whole)
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
 * `limit`, it streams, counted, and stops at the limit (`reached`).
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
    const meter = await tokenMeter(session, limit, signal)
    const stopper = internalAbort(signal, CAP_REACHED)
    try {
      try {
        for await (const chunk of copy.promptStreaming(input, { ...options, signal: stopper.signal })) {
          for (const piece of piecesOf(chunk)) {
            if (piece.type === "text" && typeof piece.value === "string") await meter.push(piece.value)
            if (meter.reached) break
          }
          if (meter.reached) {
            stopper.stop()
            break
          }
        }
      } catch (error) {
        if (!meter.reached || signal?.aborted) throw error
      }
      return { text: meter.text, reached: meter.reached }
    } finally {
      stopper.dispose()
      meter.destroy()
    }
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
 * if ((await promptApiAvailability()) !== "unavailable") {
 *   chat({ adapter: promptApiText(), messages, threadId })
 * }
 * ```
 */
export function promptApiText(
  config: PromptApiTextConfig = {}
): PromptApiTextAdapter {
  return new PromptApiTextAdapter(config)
}
