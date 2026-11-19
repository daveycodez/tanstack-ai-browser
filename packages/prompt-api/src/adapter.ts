/**
 * A TanStack AI text adapter for the browser's built-in language model,
 * through the Prompt API (`LanguageModel`): Gemini Nano in Chrome,
 * Aion-1.1-Instruct in Edge. The browser downloads and runs the model itself;
 * nothing leaves the device. Hand it to `chat()` like any hosted model's
 * adapter: `chat()` runs tools and the agent loop, and each `chatStream`
 * call here is one step of the model, streamed back as AG-UI events.
 *
 * Each thread (`threadId`) keeps a session: a step prompts it with only the
 * messages it hasn't seen, and a conversation that changed (an edit, a new
 * system prompt) starts a new one. Tools use the browser's own tool calling
 * where it has it (the session declares them; calls and results are
 * `tool-call` and `tool-response` content), else they go by prompt
 * (`tools.ts`). Structured output prompts the thread's session under the
 * Prompt API's own `responseConstraint`.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage, Tool } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { contentText, mediaIn, toLanguageModelMessages } from "./messages.js"
import { baseOptions, createSession, DEFAULT_LANGUAGES, MEDIA_INPUTS, promptApiAvailability } from "./model.js"
import type { Availability, MediaInput } from "./model.js"
import type { PromptApiChatModel } from "./model-meta.js"
import { RUNAWAY_WHITESPACE, tokenCap, whitespaceRun } from "./runaway.js"
import { toolCallReader, toolSystemPrompt } from "./tools.js"
import { PromptApiVariant } from "./variant.js"
import { toolClasses } from "./types.js"
import type {
  DownloadProgressCallback,
  LanguageModelContent,
  LanguageModelInput,
  LanguageModelPromptOptions,
  LanguageModelSession,
  LanguageModelToolCall,
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
   * Leave the JSON schema of structured output (`chat({ outputSchema })`) out
   * of the model's input. The default for every call (a request's
   * `modelOptions.omitResponseConstraintInput` overrides it). Off by default: Chrome then writes a description of
   * the schema into the model's input and also holds the reply to it. On,
   * Chrome still holds the reply to the schema but doesn't write it into the
   * input, which saves those tokens on every call, a lot for large schemas or
   * ones made per message. The model then sees no field names or allowed
   * values, so the prompt should describe the JSON it expects. Sent only with a
   * schema; a Chrome that doesn't know the option ignores it.
   */
  omitResponseConstraintInput?: boolean
  /** Most tokens a reply may write, for every call (`modelOptions.maxOutputTokens` overrides it). None by default. */
  maxOutputTokens?: number
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
  /** Raw sampling, for extensions (web pages ignore it). Chrome refuses it together with `samplingMode`. */
  temperature?: number
  topK?: number
  /**
   * This request's: leave the JSON schema of structured output (`chat({ outputSchema })`) out
   * of the model's input. Off by default (or the adapter's `omitResponseConstraintInput`): Chrome then writes a description of
   * the schema into the model's input and also holds the reply to it. On,
   * Chrome still holds the reply to the schema but doesn't write it into the
   * input, which saves those tokens on every call, a lot for large schemas or
   * ones made per message. The model then sees no field names or allowed
   * values, so the prompt should describe the JSON it expects. Sent only with a
   * schema; a Chrome that doesn't know the option ignores it.
   */
  omitResponseConstraintInput?: boolean
  /**
   * Most tokens this reply may write (or the adapter's `maxOutputTokens`): the
   * Prompt API has no cap, so the adapter stops the reply once it has
   * streamed this many pieces (a token each in Chrome 157, and at least one). A reply stopped there finishes
   * with "length"; a structured answer fails with code "length".
   */
  maxOutputTokens?: number
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

/**
 * A thread's session (kept from the moment a step reserves it, while the
 * browser makes it), the settings it was made with, and the messages it holds.
 */
type Kept = { session: Promise<LanguageModelSession>; settings: string; seen: Array<string>; busy: boolean }

/** Closes a session once it's made; one that failed to start has nothing to close. */
const close = (session: Promise<LanguageModelSession>) => void session.then((s) => s.destroy(), () => undefined)

/** A call's arguments as compared: their JSON as parsed, else the text. */
const argumentsKey = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text
  }
}

/**
 * A message as compared with what a session holds. The model's own replies
 * go by their text and their calls (each one's id, name and arguments: a
 * native call is in the session too, so an edited one isn't what it holds).
 */
const messageKey = (m: ModelMessage) =>
  m.role === "assistant"
    ? JSON.stringify([
        "assistant",
        contentText(m.content).trim(),
        (m.toolCalls ?? []).map((call) => [call.id, call.function.name, argumentsKey(call.function.arguments)])
      ])
    : JSON.stringify([m.role, m.content, m.toolCallId ?? null, m.error ?? null])

/** The tools a step offers: none for `toolChoice: "none"`, only the chosen one for a named choice. */
function offeredTools(options: TextOptions<PromptApiTextModelOptions>): ReadonlyArray<Tool> {
  const { toolChoice, tools = [] } = options
  if (toolChoice === "none") return []
  if (typeof toolChoice === "object") return tools.filter((tool) => tool.name === toolChoice.name)
  return tools
}

/**
 * A step's system prompt and the settings its session is made with: with the
 * browser's own tool use (`native`), the caller's system prompt as given and
 * the tools declared on the session; else the caller's, then the tools by
 * prompt.
 */
function sessionSettings(
  options: TextOptions<PromptApiTextModelOptions>,
  tools: ReadonlyArray<Tool>,
  native: boolean
) {
  const caller = normalizeSystemPrompts(options.systemPrompts)
    .map((p) => p.content)
    .join("\n\n")
  const system = native ? caller : toolSystemPrompt(caller, tools)
  const declared = native ? tools.map((tool) => [tool.name, tool.description, tool.inputSchema]) : null
  const { samplingMode, temperature, topK } = options.modelOptions ?? {}
  return { system, settings: JSON.stringify([system, declared, samplingMode, temperature, topK, mediaIn(options.messages)]) }
}

/** A piece of a reply as text: a string, or `text` content. */
const pieceText = (piece: string | LanguageModelContent) =>
  typeof piece === "string" ? piece : piece.type === "text" ? String(piece.value) : ""

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
    this.omitResponseConstraintInput = config.omitResponseConstraintInput
    this.maxOutputTokens = config.maxOutputTokens
  }

  private readonly omitResponseConstraintInput: boolean | undefined
  private readonly maxOutputTokens: number | undefined

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
   * Which model the browser's Prompt API runs ("Gemini Nano", "Gemma 4",
   * "Aion-1.1-Instruct" as `displayName`), compared by identity:
   * `variant === PromptApiVariant.gemma4`. An informed guess from the browser
   * and Chrome's tool-use classes (see PromptApiVariant), before or after the
   * download: nothing is downloaded or run. Undefined where the Prompt API
   * can't run, or in a browser it can't tell.
   */
  async variant(): Promise<PromptApiVariant | undefined> {
    return (await this.availability()) === "unavailable" ? undefined : PromptApiVariant.ofBrowser()
  }

  /**
   * The kinds of input the browser's model takes here, of the
   * `inputModalities` the Prompt API has: each kind the browser's
   * `LanguageModel.availability()` doesn't call "unavailable" for this
   * adapter's `languages` (images need more of the device, audio a GPU).
   * Empty where there's no model. Sessions expect what each conversation has.
   */
  async availableInputModalities(): Promise<Array<"text" | MediaInput>> {
    if ((await promptApiAvailability(baseOptions(this.languages))) === "unavailable") return []
    const media = await Promise.all(
      MEDIA_INPUTS.map(async (kind) =>
        (await promptApiAvailability(baseOptions(this.languages, [kind]))) === "unavailable" ? [] : [kind]
      )
    )
    return ["text", ...media.flat()]
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

  /**
   * Tokens a thread's session holds (the session's `contextUsage`): the
   * system prompt, the tools and the conversation so far. The thread is
   * `chat()`'s `threadId` (or its `promptCache.key`); left out, the thread
   * used last. Undefined where the thread keeps no session.
   */
  async contextUsage(threadId?: string): Promise<number | undefined> {
    return (await this.keptSession(threadId))?.contextUsage
  }

  /**
   * Tokens a thread's session can hold (the session's `contextWindow`), for
   * the thread as `contextUsage` takes it. Undefined where the thread keeps
   * no session.
   */
  async contextWindow(threadId?: string): Promise<number | undefined> {
    return (await this.keptSession(threadId))?.contextWindow
  }

  /** A thread's kept session, or the last used thread's; undefined if there's none, or it failed to start. */
  private keptSession(threadId?: string): Promise<LanguageModelSession | undefined> {
    const kept = threadId === undefined ? [...this.kept.values()].at(-1) : this.kept.get(threadId)
    return kept ? kept.session.catch(() => undefined) : Promise.resolve(undefined)
  }

  /** Closes every thread's session. The browser keeps the model. */
  async destroy(): Promise<void> {
    for (const kept of this.kept.values()) close(kept.session)
    this.kept.clear()
  }

  /** Keeps a thread's session, closing the least recently used past the limit. */
  private keep(threadId: string, kept: Kept) {
    this.kept.delete(threadId)
    this.kept.set(threadId, kept)
    for (const [id, old] of this.kept) {
      if (this.kept.size <= KEPT_SESSIONS) break
      if (old.busy) continue
      close(old.session)
      this.kept.delete(id)
    }
  }

  /** Closes a thread's session, unless a step is using it. */
  private drop(threadId: string) {
    const kept = this.kept.get(threadId)
    if (!kept || kept.busy) return
    close(kept.session)
    this.kept.delete(threadId)
  }

  /**
   * A session for this call, holding the system prompt, that reports an
   * overflow; with `tools`, declaring them for the browser's own tool use.
   */
  private async session(
    options: TextOptions<PromptApiTextModelOptions>,
    system: string,
    signal: AbortSignal | undefined,
    tools?: ReadonlyArray<Tool>
  ): Promise<LanguageModelSession> {
    const { samplingMode, temperature, topK } = options.modelOptions ?? {}
    const session = await createSession(
      {
        ...baseOptions(this.languages, mediaIn(options.messages), !!tools),
        ...(tools && {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
          }))
        }),
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
   * new messages), else a new one with the whole conversation. The session
   * is reserved before anything is awaited, so a second step on a busy
   * thread gets a session of its own (`kept` undefined), closed after it.
   * Threads go by `promptCache.key`; retention "none" keeps no session.
   */
  private async begin(options: TextOptions<PromptApiTextModelOptions>, signal: AbortSignal | undefined) {
    const key = options.promptCache?.key ?? options.threadId
    const retain = options.promptCache?.retention !== "none"
    const tools = offeredTools(options)
    // The browser's own tool use where it has it, else tools by prompt.
    const native = tools.length > 0 ? toolClasses() : undefined
    const { system, settings } = sessionSettings(options, tools, !!native)
    const keys = options.messages.map(messageKey)
    const held = retain ? this.kept.get(key) : undefined
    const goesOn = !!held && goesOnFrom(held, settings, keys)
    let kept: Kept | undefined
    if (goesOn) kept = held
    else if (retain && !held?.busy) {
      this.drop(key)
      kept = { session: this.session(options, system, signal, native && tools), settings, seen: [], busy: false }
    }
    if (kept) {
      kept.busy = true
      this.keep(key, kept)
    }
    const pending = kept?.session ?? this.session(options, system, signal, native && tools)
    try {
      const session = await pending
      const input = await toLanguageModelMessages(options.messages, goesOn ? held.seen.length : 0, native)
      return { key, session, kept, keys, input, tools, native: !!native, goesOn }
    } catch (error) {
      // A session that goes on still holds the thread; a new one is dropped.
      this.end(key, pending, kept, !goesOn)
      throw error
    }
  }

  /** Frees a step's session: a kept one stays for the thread unless the step failed. */
  private end(key: string, session: Promise<LanguageModelSession>, kept: Kept | undefined, failed: boolean) {
    if (!kept) return close(session)
    kept.busy = false
    if (failed && this.kept.get(key) === kept) this.drop(key)
  }

  /**
   * A step's token counts, which the Prompt API doesn't report, from the
   * session's own: the tokens it held before the prompt, the prompt as the
   * session measures it, and the reply measured the same way, less an empty
   * message's tokens (the turn markers the session counts around any
   * message). What a kept session held is cached: it isn't read again. A
   * new session read what it holds (the system prompt) in this step.
   * Nothing where the browser can't measure.
   */
  private async usage(
    session: LanguageModelSession,
    held: number,
    goesOn: boolean,
    input: LanguageModelInput,
    reply: string,
    // The prompt's own options: a schema Chrome writes into the input counts as input.
    promptOptions?: LanguageModelPromptOptions
  ): Promise<TokenUsage | undefined> {
    try {
      const [read, written, markers] = await Promise.all([
        session.measureContextUsage(input, promptOptions),
        session.measureContextUsage(reply),
        session.measureContextUsage("")
      ])
      const counts = [held, read, written, markers]
      if (!counts.every((count) => Number.isFinite(count))) return undefined
      const promptTokens = held + read
      const completionTokens = Math.max(0, written - markers)
      return {
        ...buildBaseUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }),
        // What a kept session held, as TanStack reports cached tokens: left out for none (a new session read all of it).
        ...(goesOn && held > 0 && { promptTokensDetails: { cachedTokens: held } })
      }
    } catch {
      return undefined
    }
  }

  /** A call's token cap: its modelOptions', else the adapter's. */
  private capOf(options: TextOptions<PromptApiTextModelOptions>) {
    const cap = options.modelOptions?.maxOutputTokens ?? this.maxOutputTokens
    return typeof cap === "number" && cap > 0 ? cap : undefined
  }

  /**
   * A structured answer, streamed so it can be stopped: on a runaway of
   * whitespace (see runaway.ts), or at the token cap. Returns its text, and
   * why it stopped early if it did.
   */
  private async constrained(
    session: LanguageModelSession,
    input: Parameters<LanguageModelSession["prompt"]>[0],
    constraint: LanguageModelPromptOptions,
    signal: AbortSignal | undefined,
    max: number | undefined
  ): Promise<{ text: string; stopped?: "runaway" | "length" }> {
    const stop = new AbortController()
    const generation = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
    const whitespace = whitespaceRun()
    const cap = tokenCap(max)
    let text = ""
    let stopped: "runaway" | "length" | undefined
    try {
      for await (const raw of session.promptStreaming(input, { ...constraint, signal: generation })) {
        const piece = pieceText(raw)
        text += piece
        if (whitespace.push(piece) > RUNAWAY_WHITESPACE) stopped = "runaway"
        else if (cap.reached()) stopped = "length"
        if (stopped) {
          stop.abort()
          break
        }
      }
    } catch (error) {
      if (!stop.signal.aborted || signal?.aborted) throw error
    }
    return { text, ...(stopped && { stopped }) }
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
      const { session, kept, keys, input, tools, native, goesOn } = step
      // Tools by prompt: calls are read out of the text. Without tools, or with
      // the browser's own tool use, the text is all text.
      const reader = tools.length > 0 && !native ? toolCallReader(tools) : undefined
      // The browser's own calls, as they come.
      const nativeCalls: Array<LanguageModelToolCall> = []
      let text = ""
      const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        if (!text) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
        text += delta
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content: text, model, timestamp: timestamp() }
      }
      const generation = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      // What the session holds before this prompt, and all the model writes (a tool call's text too).
      const held = session.contextUsage
      let written = ""
      const cap = tokenCap(this.capOf(options))
      let capped = false
      try {
        for await (const raw of session.promptStreaming(input, { signal: generation })) {
          // A native call: the turn goes on to its end, so the session holds the call.
          if (typeof raw !== "string" && raw.type === "tool-call") {
            const call = raw.value as LanguageModelToolCall
            nativeCalls.push(call)
            // Not text, but written all the same: counted as its JSON.
            written += JSON.stringify({ name: call.name, arguments: call.arguments })
            continue
          }
          const piece = pieceText(raw)
          written += piece
          yield* textEvents(reader ? reader.push(piece) : piece)
          if (reader?.call) {
            stop.abort()
            break
          }
          if (cap.reached()) {
            capped = true
            stop.abort()
            break
          }
        }
      } catch (error) {
        if (!stop.signal.aborted || signal?.aborted) throw error
      }
      if (reader) {
        yield* textEvents(reader.end())
        // Text after the call, in the piece that closed it, is shown too.
        yield* textEvents(reader.trailing)
      }
      const calls = [
        ...nativeCalls.map((call) => ({ id: call.callId || call.callID || nextId("call"), name: call.name, arguments: call.arguments })),
        ...(reader?.call ? [{ id: nextId("call"), ...reader.call }] : [])
      ]
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      // A finished reply is in the session now, a native call included. One
      // stopped at a call by prompt isn't: Chrome drops a stopped turn whole,
      // so the next step sends it.
      if (kept && !stop.signal.aborted) {
        const toolCalls = calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
        kept.seen = [...keys, messageKey({ role: "assistant", content: text, ...(toolCalls.length && { toolCalls }) })]
      }
      for (const [index, call] of calls.entries()) {
        const toolCallId = call.id
        const args = JSON.stringify(call.arguments)
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: call.name,
          parentMessageId: messageId,
          index,
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
      const usage = await this.usage(session, held, goesOn, input, written)
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model,
        timestamp: timestamp(),
        finishReason: calls.length > 0 ? "tool_calls" : capped ? "length" : "stop",
        ...(usage && { usage })
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
      if (step) this.end(step.key, Promise.resolve(step.session), step.kept, failed)
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`: the thread's session
   * answers the conversation under the Prompt API's `responseConstraint`,
   * which holds the model to the schema as given (written into its input too,
   * unless `omitResponseConstraintInput`).
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
      const { session, kept, keys, input, goesOn } = step
      const held = session.contextUsage
      // The schema, and whether Chrome leaves it out of the input: a per-prompt
      // option, so it never carries over to another call of a kept session.
      const omit = chatOptions.modelOptions?.omitResponseConstraintInput ?? this.omitResponseConstraintInput
      const constraint: LanguageModelPromptOptions = { responseConstraint: outputSchema, ...(omit && { omitResponseConstraintInput: true }) }
      // A runaway (see runaway.ts) is asked again once: Chrome drops a stopped turn, so the session is as it was.
      let answer = await this.constrained(session, input, constraint, signal, this.capOf(chatOptions))
      if (answer.stopped === "runaway") answer = await this.constrained(session, input, constraint, signal, this.capOf(chatOptions))
      if (answer.stopped === "runaway") {
        throw Object.assign(
          new Error(`The browser's model wrote whitespace without end (more than ${RUNAWAY_WHITESPACE} characters of it outside strings), twice: the schema likely forbids what it wanted to write next`),
          { code: "runaway" }
        )
      }
      if (answer.stopped === "length") {
        throw Object.assign(new Error(`The structured answer was cut off at maxOutputTokens (${this.capOf(chatOptions)}) before its JSON was complete`), { code: "length" })
      }
      const rawText = answer.text
      if (kept) kept.seen = [...keys, messageKey({ role: "assistant", content: rawText })]
      const data = JSON.parse(rawText) as unknown
      const usage = await this.usage(session, held, goesOn, input, rawText, constraint)
      return { data, rawText, model: this.model, ...(usage && { usage }) }
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (step) this.end(step.key, Promise.resolve(step.session), step.kept, failed)
    }
  }
}

/**
 * A TanStack AI text adapter for the browser's built-in model, through the
 * Prompt API: Gemini Nano in Chrome, Aion-1.1-Instruct in Edge. The model is
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
