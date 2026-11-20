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
 * Prompt API's own `responseConstraint`. With `reasoning: "high"`, a step
 * drafts working notes before its reply (`reasoning.ts`), each on a clone of
 * the thread's session; a structured answer drafts them before its JSON too.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage, Tool } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { contentText, mediaIn, toLanguageModelMessages } from "./messages.js"
import { baseOptions, createSession, DEFAULT_LANGUAGES, MEDIA_INPUTS, promptApiAvailability } from "./model.js"
import type { Availability, MediaInput } from "./model.js"
import { PROMPT_API_MODEL_REASONING } from "./model-meta.js"
import type { PromptApiChatModel, PromptApiModelReasoningByName } from "./model-meta.js"
import { answerInstruction, draftInstruction, earlierNotes, withWorkingNotes } from "./reasoning.js"
import { RUNAWAY_WHITESPACE, tokenCap, whitespaceRun } from "./runaway.js"
import { toolCallReader, toolSystemPrompt } from "./tools.js"
import { PromptApiVariant } from "./variant.js"
import { toolClasses } from "./types.js"
import type {
  DownloadProgressCallback,
  LanguageModelContent,
  LanguageModelInput,
  LanguageModelMessage,
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
type Kept = {
  session: Promise<LanguageModelSession>
  settings: string
  seen: Array<string>
  busy: boolean
  /** The working notes of the turn in progress, a step's each: its later steps read them (see reasoning.ts). */
  notes?: Array<string>
}

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

/**
 * A step's thinking, for `reasoning: "high"` (any level of thinking is the
 * model's one): its token budget, if it has one. Undefined for a step that
 * doesn't think: reasoning off or none, or a budget of no tokens.
 */
function thinkingOf(options: TextOptions<PromptApiTextModelOptions>, model: PromptApiChatModel) {
  const reasoning = resolveReasoning(options.reasoning, PROMPT_API_MODEL_REASONING[model])
  if (reasoning?.level !== "high") return undefined
  if (reasoning.budgetTokens !== undefined && reasoning.budgetTokens <= 0) return undefined
  return { budget: reasoning.budgetTokens }
}

/** A piece of a reply as text: a string, or `text` content. */
const pieceText = (piece: string | LanguageModelContent) =>
  typeof piece === "string" ? piece : piece.type === "text" ? String(piece.value) : ""

/** Whether a conversation (its messages' keys) goes on from what a kept session holds, with its settings. */
const goesOnFrom = (held: Kept, settings: string, keys: Array<string>) =>
  !held.busy && held.settings === settings && held.seen.length < keys.length && held.seen.every((key, i) => key === keys[i])

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** A tool call a step ends with. */
type StepCall = { id: string; name: string; arguments: unknown }

/** What a draft ends with: its notes, the pieces they took, whether the output cap stopped them, and any tool call it made. */
type Drafted = { notes: string; pieces: number; capped: boolean; calls: Array<StepCall> }

/** The browser's own call as a step's, with its id when it gives one. */
const stepCall = (call: LanguageModelToolCall): StepCall => ({ id: call.callId || call.callID || nextId("call"), name: call.name, arguments: call.arguments })

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions<PromptApiTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined


export class PromptApiTextAdapter extends BaseTextAdapter<
  PromptApiChatModel,
  PromptApiTextModelOptions,
  readonly ["text", "image", "audio"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  PromptApiModelReasoningByName[PromptApiChatModel]
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
    const thinking = thinkingOf(options, this.model)
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
      return { key, session, kept, keys, input, tools, native: !!native, goesOn, thinking }
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
   * new session read what it holds (the system prompt) in this step. A
   * step's `draft` adds its own prompt (the step's messages and the draft's
   * instruction, read by the session's clone) and the notes it wrote, which
   * are also reported as the reply's reasoning tokens. Nothing where the
   * browser can't measure.
   */
  private async usage(
    session: LanguageModelSession,
    held: number,
    goesOn: boolean,
    // The reply's prompt; undefined when none was sent (the draft made the step's tool call).
    input: LanguageModelInput | undefined,
    reply: string,
    // The prompt's own options: a schema Chrome writes into the input counts as input.
    promptOptions?: LanguageModelPromptOptions,
    draft?: { input: LanguageModelInput; notes: string }
  ): Promise<TokenUsage | undefined> {
    try {
      const [read, written, markers, draftRead, draftWritten] = await Promise.all([
        input ? session.measureContextUsage(input, promptOptions) : 0,
        session.measureContextUsage(reply),
        session.measureContextUsage(""),
        draft ? session.measureContextUsage(draft.input) : 0,
        draft ? session.measureContextUsage(draft.notes) : 0
      ])
      const counts = [held, read, written, markers, draftRead, draftWritten]
      if (!counts.every((count) => Number.isFinite(count))) return undefined
      const promptTokens = held + read + draftRead
      const reasoningTokens = draft ? Math.max(0, draftWritten - markers) : 0
      const completionTokens = Math.max(0, written - markers) + reasoningTokens
      return {
        ...buildBaseUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }),
        // What a kept session held, as TanStack reports cached tokens: left out for none (a new session read all of it).
        ...(goesOn && held > 0 && { promptTokensDetails: { cachedTokens: held } }),
        ...(draft && { completionTokensDetails: { reasoningTokens } })
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

  /**
   * A step's working notes, drafted before its reply (see reasoning.ts): a
   * clone of the step's session reads `input` (the draft's instruction, after
   * the step's messages where the session doesn't hold them yet) and writes
   * the notes, so the step's session holds nothing of the draft. Yields the notes as they're written; returns them,
   * the pieces they took (a token each, as `tokenCap` counts) and whether the
   * output cap (`max`) stopped them. The thinking `budget` stops them too:
   * the notes end where they are, and the reply follows.
   *
   * Asked not to, the model sometimes calls a tool in its draft all the same
   * (Gemini Nano in Chrome 157: one draft in seven of a question that needs a
   * search; with the call left in its notes, its reply then made up the
   * tool's result). Such a call is the step's: the notes end before it, and
   * `calls` has it (by prompt, read by `reader` as in a reply; or the
   * browser's own).
   */
  private async *draft(
    session: LanguageModelSession,
    input: LanguageModelInput,
    signal: AbortSignal | undefined,
    budget: number | undefined,
    max: number | undefined,
    reader: ReturnType<typeof toolCallReader> | undefined
  ): AsyncGenerator<string, Drafted> {
    const stop = new AbortController()
    const generation = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
    const clone = await session.clone(signal ? { signal } : undefined)
    const cap = tokenCap(max)
    const budgeted = tokenCap(budget)
    const calls: Array<StepCall> = []
    let notes = ""
    let pieces = 0
    let capped = false
    try {
      for await (const raw of clone.promptStreaming(input, { signal: generation })) {
        pieces++
        if (typeof raw !== "string" && raw.type === "tool-call") {
          calls.push(stepCall(raw.value as LanguageModelToolCall))
        } else {
          const piece = pieceText(raw)
          const shown = reader ? reader.push(piece) : piece
          notes += shown
          if (shown) yield shown
        }
        capped = cap.reached()
        if (reader?.call || capped || budgeted.reached()) {
          stop.abort()
          break
        }
      }
    } catch (error) {
      if (!stop.signal.aborted || signal?.aborted) throw error
    } finally {
      // Also when the stream is left unread: the clone stops writing.
      stop.abort()
      clone.destroy()
    }
    if (reader) {
      // What the reader held back: text, unless it's a call in a fence the draft left open.
      const rest = reader.end()
      notes += rest
      if (rest) yield rest
      if (reader.call) calls.push({ id: nextId("call"), ...reader.call })
    }
    return { notes, pieces, capped, calls }
  }

  /**
   * A draft's notes as reasoning events, as they're written; none for a draft
   * that writes nothing. Returns what the draft ends with. The reasoning is
   * ended before a failure of the draft's is thrown on.
   */
  private async *reasoned(draft: AsyncGenerator<string, Drafted>): AsyncGenerator<AdapterYieldChunk, Drafted> {
    const model = this.model
    const messageId = nextId("reasoning")
    let opened = false
    const closing = (): Array<AdapterYieldChunk> =>
      opened
        ? [
            { type: EventType.REASONING_MESSAGE_END, messageId, model, timestamp: Date.now() },
            { type: EventType.REASONING_END, messageId, model, timestamp: Date.now() }
          ]
        : []
    let next: IteratorResult<string, Drafted>
    try {
      while (!(next = await draft.next()).done) {
        if (!opened) {
          opened = true
          yield { type: EventType.REASONING_START, messageId, model, timestamp: Date.now() }
          yield { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning", model, timestamp: Date.now() }
        }
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: next.value, model, timestamp: Date.now() }
      }
    } catch (error) {
      yield* closing()
      throw error
    } finally {
      // Left unread: the notes stop being written.
      await draft.return({ notes: "", pieces: 0, capped: false, calls: [] })
    }
    yield* closing()
    return next.value
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
      const { session, kept, keys, tools, native, goesOn } = step
      // What the session holds before this step's prompts.
      const held = session.contextUsage
      const max = this.capOf(options)
      // With reasoning, the working notes first: streamed as reasoning, then
      // the last message of the reply's prompt. A tool call the draft made is
      // the step's, and nothing more is asked.
      let draft: ({ input: LanguageModelInput } & Drafted) | undefined
      let input: Array<LanguageModelMessage> = step.input
      // What the session itself reads in this step, for its token counts.
      let read: Array<LanguageModelMessage> | undefined = step.input
      // The session the reply is asked of: the step's, or with reasoning a clone of it.
      let replier = session
      if (step.thinking) {
        // The thread's session reads the step's messages once (`append`) and
        // stays the thread's: the draft and the reply each go on from a clone
        // of it, so it holds neither the instruction nor the notes, and the
        // next turn goes on from what it holds. The reply isn't in it: the
        // next step sends that. Where the browser has no `append`, the clones
        // read the step's messages themselves, and the next step sends them again.
        const appends = typeof session.append === "function"
        if (appends) {
          if (step.input.length > 0) await session.append?.(step.input, signal ? { signal } : undefined)
          if (kept) kept.seen = keys
        }
        const before = appends ? [] : step.input
        // A step that brings a tool's results goes on a turn: it reads the notes of the turn's earlier steps,
        // after its own messages. (Not their instructions: those were only ever a clone's.)
        const earlier = options.messages.at(-1)?.role === "tool" ? (kept?.notes ?? []) : []
        const draftInput = [...before, ...earlierNotes(earlier), draftInstruction(options.messages)]
        const draftReader = tools.length > 0 && !native ? toolCallReader(tools) : undefined
        const ended = yield* this.reasoned(this.draft(session, draftInput, signal, step.thinking.budget, max, draftReader))
        draft = { input: draftInput, ...ended }
        const noted = draft.notes ? [...earlier, draft.notes] : earlier
        if (kept) kept.notes = noted
        input = withWorkingNotes(before, noted.join("\n\n"))
        const replied = !draft.capped && draft.calls.length === 0
        read = appends ? [...step.input, ...(replied ? input : [])] : replied ? input : undefined
        if (replied) replier = await session.clone(signal ? { signal } : undefined)
      }
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
      // All the model writes in its reply (a tool call's text too).
      let written = ""
      // The cap covers the notes and the reply together: notes that reached it leave no reply.
      const cap = tokenCap(max === undefined ? undefined : max - (draft?.pieces ?? 0))
      let capped = !!draft?.capped
      // The draft's own tool call ends the step: no reply is asked for.
      const drafted = draft?.calls.length ? draft.calls : undefined
      // Not text, but written all the same: counted as its JSON.
      if (drafted) written = drafted.map((call) => JSON.stringify({ name: call.name, arguments: call.arguments })).join("")
      try {
        for await (const raw of capped || drafted ? [] : replier.promptStreaming(input, { signal: generation })) {
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
      } finally {
        // The reply's clone ends with the reply.
        if (replier !== session) replier.destroy()
      }
      if (reader) {
        yield* textEvents(reader.end())
        // Text after the call, in the piece that closed it, is shown too.
        yield* textEvents(reader.trailing)
      }
      const calls: Array<StepCall> = drafted ?? [
        ...nativeCalls.map(stepCall),
        ...(reader?.call ? [{ id: nextId("call"), ...reader.call }] : [])
      ]
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      // A reply without a call ends the turn: its notes are no later turn's.
      if (kept && calls.length === 0) kept.notes = undefined
      // A finished reply is in the session now, a native call included. One
      // stopped at a call by prompt isn't: Chrome drops a stopped turn whole,
      // so the next step sends it. Nor is a thinking step's, written by a clone.
      if (kept && !stop.signal.aborted && !step.thinking) {
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
      const usage = await this.usage(session, held, goesOn, read, written, undefined, draft)
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
   * Structured output as events, for `chat({ outputSchema })`, streaming or not:
   * the events chat() would make around `structuredOutput()` itself, with the
   * working notes of a thinking answer as reasoning events before it, and with
   * the error's code. chat() keeps a run error's code only from its RUN_ERROR
   * event, and its own wrapper keeps only a parse failure's
   * ("structured-output-parse-failed"), so without this "runaway" and "length"
   * lost theirs.
   */
  async *structuredOutputStream(options: StructuredOutputOptions<PromptApiTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const { chatOptions } = options
    const runId = chatOptions.runId ?? nextId("run")
    const { threadId } = chatOptions
    const messageId = nextId("msg")
    const model = this.model
    yield { type: EventType.RUN_STARTED, runId, threadId, model, timestamp: Date.now() }
    let result: StructuredOutputResult<unknown>
    try {
      // With reasoning, the working notes come first, as reasoning events.
      result = yield* this.answerStructured(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const own = (error as { code?: unknown } | undefined)?.code
      const parseFailed = error instanceof SyntaxError || (error instanceof Error && error.cause instanceof SyntaxError)
      const code = typeof own === "string" ? own : parseFailed ? "structured-output-parse-failed" : undefined
      yield {
        type: EventType.RUN_ERROR,
        runId,
        threadId,
        model,
        timestamp: Date.now(),
        message,
        ...(code && { code }),
        error: { message, ...(code && { code }) }
      }
      return
    }
    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: Date.now() }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: result.rawText, model, timestamp: Date.now() }
    yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: Date.now() }
    yield {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: { object: result.data, raw: result.rawText },
      model,
      timestamp: Date.now()
    }
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      model: result.model ?? model,
      timestamp: Date.now(),
      finishReason: "stop",
      ...(result.usage && { usage: result.usage })
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
    // The notes of a thinking answer aren't streamed here: structuredOutputStream() has them.
    const steps = this.answerStructured(options)
    for (;;) {
      const step = await steps.next()
      if (step.done) return step.value
    }
  }

  /**
   * A structured answer's steps. Without reasoning, one prompt of the thread's
   * session under the schema. With `reasoning: "high"`, working notes first,
   * which come as reasoning events (see reasoning.ts): the thread's session
   * reads the step's messages, a clone of it drafts the notes, and another
   * clone answers under the schema with the notes in hand, as a reply's does.
   */
  private async *answerStructured(
    options: StructuredOutputOptions<PromptApiTextModelOptions>
  ): AsyncGenerator<AdapterYieldChunk, StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    let step: Awaited<ReturnType<typeof this.begin>> | undefined
    let failed = false
    try {
      step = await this.begin(chatOptions, signal)
      const { session, kept, keys, goesOn } = step
      const held = session.contextUsage
      const max = this.capOf(chatOptions)
      // The schema, and whether Chrome leaves it out of the input: a per-prompt
      // option, so it never carries over to another call of a kept session.
      const omit = chatOptions.modelOptions?.omitResponseConstraintInput ?? this.omitResponseConstraintInput
      const constraint: LanguageModelPromptOptions = { responseConstraint: outputSchema, ...(omit && { omitResponseConstraintInput: true }) }
      let draft: ({ input: LanguageModelInput } & Drafted) | undefined
      let input: Array<LanguageModelMessage> = step.input
      // What the session itself reads in this step, for its token counts.
      let read: Array<LanguageModelMessage> = step.input
      // The session the answer is asked of: the step's, or with reasoning a clone of it.
      let answerer = session
      // The instruction is about the user's message above it: an answer that follows anything else (a tool's
      // results, after chat()'s agent loop) is asked for without notes.
      const thinking = chatOptions.messages.at(-1)?.role === "user" ? step.thinking : undefined
      if (thinking) {
        // As a reply's thinking (see chatStream): the thread's session reads
        // the step's messages once and holds neither the instruction nor the
        // notes, and where the browser has no `append` the clones read the
        // messages themselves.
        const appends = typeof session.append === "function"
        if (appends) {
          if (step.input.length > 0) await session.append?.(step.input, signal ? { signal } : undefined)
          if (kept) kept.seen = keys
        }
        const before = appends ? [] : step.input
        const draftInput = [...before, answerInstruction()]
        // No tool reader: a structured answer has no tools, so all the draft writes is notes.
        const ended = yield* this.reasoned(this.draft(session, draftInput, signal, thinking.budget, max, undefined))
        draft = { input: draftInput, ...ended }
        // The cap covers the notes and the answer together: notes that reached it leave no answer.
        if (draft.capped) {
          throw Object.assign(new Error(`The working notes used up maxOutputTokens (${max}): none are left for the structured answer`), { code: "length" })
        }
        input = withWorkingNotes(before, draft.notes)
        read = appends ? [...step.input, ...input] : input
        answerer = await session.clone(signal ? { signal } : undefined)
      }
      const left = max === undefined ? undefined : max - (draft?.pieces ?? 0)
      let answer: Awaited<ReturnType<typeof this.constrained>>
      try {
        // A runaway (see runaway.ts) is asked again once: Chrome drops a stopped turn, so the session is as it was.
        answer = await this.constrained(answerer, input, constraint, signal, left)
        if (answer.stopped === "runaway") answer = await this.constrained(answerer, input, constraint, signal, left)
      } finally {
        // The answer's clone ends with the answer.
        if (answerer !== session) answerer.destroy()
      }
      if (answer.stopped === "runaway") {
        throw Object.assign(
          new Error(`The browser's model wrote whitespace without end (more than ${RUNAWAY_WHITESPACE} characters of it outside strings), twice: the schema likely forbids what it wanted to write next`),
          { code: "runaway" }
        )
      }
      if (answer.stopped === "length") {
        throw Object.assign(new Error(`The structured answer was cut off at maxOutputTokens (${max}) before its JSON was complete`), { code: "length" })
      }
      const rawText = answer.text
      // The answer is in the session now. Not a thinking step's, written by a clone: the next step sends that.
      if (kept && !step.thinking) kept.seen = [...keys, messageKey({ role: "assistant", content: rawText })]
      const data = JSON.parse(rawText) as unknown
      const usage = await this.usage(session, held, goesOn, read, rawText, constraint, draft)
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
