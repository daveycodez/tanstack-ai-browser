/**
 * A TanStack AI text adapter for Apple's on-device model, through the
 * Foundation Models framework itself: the Capacitor plugin on iOS, or any
 * host that implements `AfmNative`. Hand it to `chat()` like any
 * other adapter: `chat()` runs the tools and the agent loop, and each
 * `chatStream` call here is one step of the model, streamed as AG-UI events.
 *
 * Tools are the framework's own, so the model's arguments always fit their
 * parameters, and it calls several at once. The framework runs a tool in the
 * middle of a response; here the call is reported to `chat()` (the step ends
 * with `tool_calls`) while the native response waits, and the next step hands
 * it the results: the response goes on where it was, without the session
 * reading the conversation again.
 *
 * Each thread (`threadId`) keeps a session: a step prompts it with only the
 * new message. A conversation that changed (an edit, other tools, a new
 * system prompt) starts a new session from the messages.
 *
 * With `reasoning: "high"`, a step that answers a message drafts working
 * notes before its reply (`reasoning.ts`), in the thread's own session, so
 * what the session has read is reused from turn to turn.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage, Tool } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { contentText, toNativeMessages } from "./messages.js"
import { AFM_MODEL_REASONING } from "./model-meta.js"
import type { AfmChatModel, AfmModelReasoningByName } from "./model-meta.js"
import { Afm } from "./native.js"
import type { AfmGuardrails, AfmNative, AfmSampling, NativeEvent, NativeMessage, NativeUsage, UnavailableReason } from "./native.js"
import { draftInstruction, draftPrompt, REPLY_PROMPT, thoughtsPrompt } from "./reasoning.js"
import { toNativeSchema } from "./schema.js"
import * as SystemLanguageModel from "./system-language-model.js"

export type AfmConfig = {
  /**
   * The native side. By default `window.afm` where a host put it there
   * (Electron, with `serveAfm()` in the main process), else the Capacitor
   * plugin (`Afm`).
   */
  native?: AfmNative
  /**
   * Apple's guardrails: "default" (the default), or "permissiveContentTransformations",
   * for text the default ones block out of context, such as a card game's card
   * names. A request's `modelOptions.guardrails` overrides it.
   */
  guardrails?: AfmGuardrails
  /**
   * How responses pick their tokens: "greedy", `{ topK, seed? }` or `{ topP, seed? }`.
   * Left out, Apple's default. A request's `modelOptions.sampling` overrides it.
   * "greedy" steadies short answers such as structured output's small enums.
   */
  sampling?: AfmSampling
  /**
   * Whether structured output's schema is written into the model's prompt
   * (Apple's `includeSchemaInPrompt`): true by default. False leaves it out,
   * which saves its tokens on every call (about 450 for DeckGen's schemas);
   * the framework still holds the answer to the schema, but the model doesn't
   * read its field names or allowed values (nor described enum values), so
   * the prompt should name them. A request's `modelOptions` overrides it.
   */
  includeSchemaInPrompt?: boolean
}

/** Per-call `modelOptions`: the response's sampling and length, and the guardrails. */
export type AfmTextModelOptions = {
  temperature?: number
  /** Most tokens to generate. */
  maximumResponseTokens?: number
  /** Apple's guardrails for this request's session, over the adapter's `guardrails`. */
  guardrails?: AfmGuardrails
  /** How this response picks its tokens, over the adapter's `sampling`. */
  sampling?: AfmSampling
  /** Whether this structured answer's schema is written into the prompt, over the adapter's `includeSchemaInPrompt`. */
  includeSchemaInPrompt?: boolean
}

export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

type MetadataByModality = {
  text: unknown
  image: unknown
  audio: unknown
  video: unknown
  document: unknown
}

/** Events of one native response, as they come. */
class EventQueue {
  private readonly events: Array<NativeEvent> = []
  private wake: (() => void) | undefined

  push(event: NativeEvent) {
    this.events.push(event)
    this.wake?.()
    this.wake = undefined
  }

  async next(signal: AbortSignal | undefined): Promise<NativeEvent> {
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
    return this.events.shift() as NativeEvent
  }
}

/** A thread's native session, and its response in progress (waiting at tool calls). */
type Thread = {
  sessionId: string
  settings: string
  /** The conversation the session holds, by message key. */
  seen: Array<string>
  turn: number
  /** The response in progress: set from `respond` until `done` or an error. */
  queue: EventQueue | undefined
  /** The response's text so far, over all its steps. */
  written: string
  /** Tool calls reported to `chat()` that wait for results. */
  waiting: Set<string>
  busy: boolean
  /**
   * A thinking turn, until its reply is done: how many prompts the session's
   * conversation has for it (each time it thought, the notes' and the ask for
   * the reply, or one holding the notes), and the user's message they stand for
   * (none for a turn that began with a tool's result).
   */
  thought?: { prompts: number; message: string | undefined }
}

const KEPT_SESSIONS = 4

/** A message, as the session holds it: an assistant's text and its tool calls (ids, names, arguments). */
const messageKey = (m: ModelMessage) =>
  m.role === "assistant"
    ? JSON.stringify([
        "assistant",
        contentText(m.content).trim(),
        (m.toolCalls ?? []).map((call) => [call.id, call.function.name, call.function.arguments])
      ])
    : JSON.stringify([m.role, contentText(m.content), m.toolCallId ?? null])

function offeredTools(options: TextOptions<AfmTextModelOptions>): ReadonlyArray<Tool> {
  const { toolChoice, tools = [] } = options
  if (toolChoice === "none") return []
  if (typeof toolChoice === "object") return tools.filter((tool) => tool.name === toolChoice.name)
  return tools
}

/** The framework's tool-calling mode for a step: "required" when a tool must be called ("required", or the one tool named). */
const toolCallingModeOf = (options: TextOptions<AfmTextModelOptions>) =>
  options.toolChoice === "required" || typeof options.toolChoice === "object" ? ("required" as const) : undefined

/** The session's instructions: the caller's system prompts, as given (when to call tools is the caller's to say). */
const instructionsOf = (options: TextOptions<AfmTextModelOptions>) =>
  normalizeSystemPrompts(options.systemPrompts)
    .map((p) => p.content)
    .filter(Boolean)
    .join("\n\n")

const AVAILABILITY: Record<UnavailableReason, Availability> = {
  deviceNotEligible: "unavailable",
  appleIntelligenceNotEnabled: "unavailable",
  unsupportedOS: "unavailable",
  unavailable: "unavailable",
  // Apple Intelligence is on, and its model is still downloading.
  modelNotReady: "downloading"
}

const usageOf = (usage: NativeUsage | undefined): TokenUsage | undefined =>
  usage && {
    ...buildBaseUsage({
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens
    }),
    // The prompt tokens the framework reused, as TanStack reports them: left out for none, or where the framework can't say.
    ...(usage.cachedTokens ? { promptTokensDetails: { cachedTokens: usage.cachedTokens } } : {}),
    // Before iOS/macOS 26.4 the native side can only estimate the tokens: said to be an estimate.
    ...(usage.estimated && { providerUsageDetails: { estimated: true } })
  }

/**
 * A thinking step's tokens: its two responses' together (the draft's, then
 * the reply's), the draft's output as the reply's reasoning tokens.
 */
const thinkingUsageOf = (draft: NativeUsage | undefined, reply: NativeUsage | undefined): TokenUsage | undefined => {
  if (!draft || !reply) return usageOf(draft ?? reply)
  const cachedTokens = (draft.cachedTokens ?? 0) + (reply.cachedTokens ?? 0)
  return {
    ...usageOf({
      inputTokens: draft.inputTokens + reply.inputTokens,
      outputTokens: draft.outputTokens + reply.outputTokens,
      ...(cachedTokens > 0 && { cachedTokens }),
      ...((draft.estimated || reply.estimated) && { estimated: true })
    }),
    completionTokensDetails: { reasoningTokens: draft.outputTokens }
  } as TokenUsage
}

/**
 * A step's thinking, for `reasoning: "high"` (any level of thinking is the
 * model's one): its token budget, if it has one. Undefined for a step that
 * doesn't think: reasoning off or none, or a budget of no tokens.
 */
function thinkingOf(options: TextOptions<AfmTextModelOptions>, model: AfmChatModel) {
  const reasoning = resolveReasoning(options.reasoning, AFM_MODEL_REASONING[model])
  if (reasoning?.level !== "high") return undefined
  if (reasoning.budgetTokens !== undefined && reasoning.budgetTokens <= 0) return undefined
  return { budget: reasoning.budgetTokens }
}

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** The model's tool calls, as the events `chat()` runs them from. */
function* toolCallChunks(
  calls: ReadonlyArray<{ id: string; name: string; arguments: string }>,
  parentMessageId: string,
  model: string
): Generator<AdapterYieldChunk> {
  for (const [index, call] of calls.entries()) {
    yield { type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name, parentMessageId, index, model, timestamp: Date.now() }
    yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: call.arguments, args: call.arguments, model, timestamp: Date.now() }
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId: call.id,
      toolCallName: call.name,
      args: call.arguments,
      input: parse(call.arguments),
      model,
      timestamp: Date.now()
    }
  }
}

/** A failed or stopped step's RUN_ERROR, with the error's code (`aborted` for a stop). */
function runError(error: unknown, aborted: boolean, runId: string, model: string): AdapterYieldChunk {
  const message = error instanceof Error ? error.message : String(error)
  const code = aborted ? "aborted" : (error as { code?: unknown })?.code
  return {
    type: EventType.RUN_ERROR,
    runId,
    model,
    timestamp: Date.now(),
    message,
    // At the top too: chat() puts only this one on the error it throws.
    ...(typeof code === "string" && { code }),
    error: { message, ...(typeof code === "string" && { code }) }
  }
}

const signalOf = (options: TextOptions<AfmTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export class AfmTextAdapter extends BaseTextAdapter<
  AfmChatModel,
  AfmTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  AfmModelReasoningByName[AfmChatModel]
> {
  override readonly kind = "text" as const
  readonly name = "afm" as const
  override readonly provider = "afm" as const
  override readonly api = "afm" as const
  override readonly inputModalities = ["text"] as const
  private readonly native: AfmNative
  private readonly threads = new Map<string, Thread>()
  private readonly queues = new Map<string, Thread>()
  /**
   * Responses waiting for tool results in sessions no thread keeps (prompt
   * cache retention "none"), by thread: the next step resumes them.
   */
  private readonly paused = new Map<string, Thread>()
  private listening: ReturnType<AfmNative["addListener"]> | undefined

  constructor(config: AfmConfig, model: AfmChatModel) {
    super({}, model)
    this.native = config.native ?? (globalThis as { afm?: AfmNative }).afm ?? Afm
    this.guardrails = config.guardrails
    this.sampling = config.sampling
    this.includeSchemaInPrompt = config.includeSchemaInPrompt
  }

  private readonly sampling: AfmSampling | undefined
  private abilities: Promise<{ edits: boolean; stops: boolean }> | undefined

  /** What the native side can do to a session's conversation, asked once. */
  private able() {
    const trims = typeof this.native.trimTranscript === "function"
    const finishes = typeof this.native.finishToolCalls === "function"
    return (this.abilities ??=
      trims || finishes
        ? this.native.availability(this.guardrails ? { guardrails: this.guardrails } : undefined).then(
            (answer) => ({ edits: trims && answer.editsTranscript === true, stops: finishes && answer.stopsAtToolCalls === true }),
            () => ({ edits: false, stops: false })
          )
        : Promise.resolve({ edits: false, stops: false }))
  }

  /** Whether the native side takes entries back out of a session's own conversation (iOS/macOS 27). */
  private async editsTranscript() {
    return (await this.able()).edits
  }

  /** Whether the native side can end a response at its tool calls, with their results in the session's conversation after them. */
  private async stopsAtToolCalls() {
    return (await this.able()).stops
  }
  private readonly includeSchemaInPrompt: boolean | undefined

  private readonly guardrails: AfmGuardrails | undefined

  /** A request's sampling: its own, else the adapter's (left out: Apple's default). */
  private samplingOf(options: TextOptions<AfmTextModelOptions>) {
    return options.modelOptions?.sampling ?? this.sampling
  }

  /** A request's guardrails: its own, else the adapter's (left out: the host's, else Apple's default). */
  private guardrailsOf(options: TextOptions<AfmTextModelOptions>) {
    return options.modelOptions?.guardrails ?? this.guardrails
  }

  /** Whether Apple's model can run here: "downloading" while Apple Intelligence gets it. */
  async availability(): Promise<Availability> {
    try {
      const answer = await this.native.availability(this.guardrails ? { guardrails: this.guardrails } : undefined)
      return answer.available ? "available" : AVAILABILITY[answer.reason ?? "unavailable"]
    } catch {
      return "unavailable"
    }
  }

  /** Tokens a session holds (iOS/macOS 26.0 and later). */
  async contextSize(): Promise<number | undefined> {
    try {
      return (await this.native.availability(this.guardrails ? { guardrails: this.guardrails } : undefined)).contextSize
    } catch {
      return undefined
    }
  }

  /**
   * Which Apple model runs here, as Apple's guide "Detecting available Apple
   * Foundation Models" checks it (natively, on iOS and in Electron): one of
   * `SystemLanguageModel.Variant`'s constants, so `===` compares like Swift's
   * `==`. Undefined when the model can't run here.
   */
  async variant(): Promise<SystemLanguageModel.Variant | undefined> {
    try {
      const answer = await this.native.availability(this.guardrails ? { guardrails: this.guardrails } : undefined)
      return answer.available ? SystemLanguageModel.Variant.fromNative(answer) : undefined
    } catch {
      return undefined
    }
  }

  /** Resolves to this adapter if the model can run here, else rejects. */
  async create(options: { signal?: AbortSignal } = {}): Promise<this> {
    options.signal?.throwIfAborted()
    const answer = await this.native.availability()
    options.signal?.throwIfAborted()
    if (!answer.available) throw new Error(`Apple's on-device model is unavailable here (${answer.reason ?? "unavailable"})`)
    return this
  }

  /**
   * Ends every session: the threads', responses waiting for tool results, and
   * responses streaming now (structured output's, and those of sessions no
   * thread keeps), each once. Then stops listening to the native side, which
   * would otherwise keep sending this adapter every later adapter's events;
   * used again, the adapter listens again.
   */
  async destroy(): Promise<void> {
    const all = new Set([...this.threads.values(), ...this.paused.values(), ...this.queues.values()])
    for (const thread of all) this.close(thread)
    this.threads.clear()
    this.paused.clear()
    const listening = this.listening
    this.listening = undefined
    await listening?.then((handle) => handle.remove()).catch(() => undefined)
  }

  /** Routes the native events to their thread's response. Listens once, until `destroy()`. */
  private listen() {
    this.listening ??= this.native.addListener("event", (event) => {
      const thread = this.queues.get(event.sessionId)
      if (thread && event.turn === thread.turn) thread.queue?.push(event)
    })
    return this.listening
  }

  /** Ends a session. A response still streaming from it ends with an error. */
  private close(thread: Thread) {
    this.queues.delete(thread.sessionId)
    thread.queue?.push({ type: "error", code: "closed", message: "The session was closed", sessionId: thread.sessionId, turn: thread.turn })
    thread.queue = undefined
    void this.native.deleteSession({ sessionId: thread.sessionId }).catch(() => undefined)
  }

  /** Keeps a thread's session, ending the least recently used past the limit. */
  private keep(key: string, thread: Thread) {
    this.threads.delete(key)
    this.threads.set(key, thread)
    for (const [id, old] of this.threads) {
      if (this.threads.size <= KEPT_SESSIONS) break
      if (old.busy) continue
      this.close(old)
      this.threads.delete(id)
    }
  }

  /** A new native session for a thread, holding `messages`. */
  private async open(
    options: TextOptions<AfmTextModelOptions>,
    tools: ReadonlyArray<Tool>,
    settings: string,
    messages: Array<NativeMessage>
  ): Promise<Thread> {
    const thread: Thread = {
      sessionId: nextId("session"),
      settings,
      seen: [],
      turn: 0,
      queue: undefined,
      written: "",
      waiting: new Set(),
      busy: true
    }
    const instructions = instructionsOf(options)
    await this.native.createSession({
      sessionId: thread.sessionId,
      ...(instructions && { instructions }),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: toNativeSchema(tool.inputSchema ?? { type: "object", properties: {} }, tool.name)
      })),
      messages,
      ...(this.guardrailsOf(options) && { guardrails: this.guardrailsOf(options) })
    })
    return thread
  }

  /**
   * The step's thread, and what it sends: the results of the tool calls its
   * response waits on, a new prompt to its session, or (for a conversation the
   * session doesn't hold) a new session and the last message as its prompt.
   */
  private async begin(options: TextOptions<AfmTextModelOptions>) {
    await this.listen()
    const key = options.promptCache?.key ?? options.threadId
    const retain = options.promptCache?.retention !== "none"
    const tools = offeredTools(options)
    const { temperature, maximumResponseTokens } = options.modelOptions ?? {}
    const settings = JSON.stringify([
      instructionsOf(options),
      tools.map((tool) => [tool.name, tool.description, tool.inputSchema]),
      temperature,
      maximumResponseTokens,
      // A response keeps the mode it started with: a step with another mode
      // (required, then auto) can't resume it, and starts a new session.
      toolCallingModeOf(options),
      // A session's guardrails are its model's: other guardrails, another session.
      // None named isn't "default": the host's (serveAfm's) may be permissive.
      this.guardrailsOf(options) ?? "inherited"
    ])
    const keys = options.messages.map(messageKey)
    // A kept session, or one whose response waits for tool results.
    const held = (retain ? this.threads.get(key) : undefined) ?? this.paused.get(key)
    const holds = !!held && !held.busy && held.settings === settings && held.seen.every((k, i) => k === keys[i])

    // The results of the tool calls the session's response waits on.
    if (holds && held.queue && held.waiting.size > 0) {
      const results = options.messages
        .slice(held.seen.length)
        .filter((m) => m.role === "tool" && !!m.toolCallId && held.waiting.has(m.toolCallId))
      if (results.length === held.waiting.size) {
        held.busy = true
        this.paused.delete(key)
        return { key, thread: held, kept: this.threads.get(key) === held, keys, results }
      }
    }
    // A new message to the session's finished response.
    const last = options.messages.at(-1)
    if (holds && !held.queue && keys.length === held.seen.length + 1 && last?.role === "user") {
      held.busy = true
      return { key, thread: held, kept: true, keys, prompt: contentText(last.content) }
    }
    // A new session for the conversation, prompted with its last message.
    if (held && !held.busy) {
      this.close(held)
      if (this.threads.get(key) === held) this.threads.delete(key)
      if (this.paused.get(key) === held) this.paused.delete(key)
    }
    const prompted = last?.role === "user"
    const before = prompted ? options.messages.slice(0, -1) : options.messages
    const thread = await this.open(options, tools, settings, toNativeMessages(before))
    const kept = retain && !this.threads.get(key)?.busy
    if (kept) this.keep(key, thread)
    return { key, thread, kept, keys, prompt: prompted ? contentText(last.content) : "" }
  }

  async *chatStream(options: TextOptions<AfmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
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
    let paused = false
    try {
      // A stopped request starts no native work (and one stopped meanwhile ends here).
      signal?.throwIfAborted()
      step = await this.begin(options)
      signal?.throwIfAborted()
      const { thread, keys } = step
      // A thinking step's draft: its tokens, and a tool call it ended with, read first below.
      let draftUsage: NativeUsage | undefined
      let first: NativeEvent | undefined
      const thinking = thinkingOf(options, model)
      // Whether a response can be ended at its tool calls, for notes about their results.
      const canStop = thinking ? await this.stopsAtToolCalls() : false
      const { temperature, maximumResponseTokens: max } = options.modelOptions ?? {}
      // A new message starts a new turn: nothing of an earlier turn's thinking is left to take out.
      if (!step.results) thread.thought = undefined
      // A response of the session's to `prompt`, as events.
      const respond = async (prompt: string, tokens: number | undefined, toolCallingMode: "required" | "disallowed" | undefined) => {
        const queue = new EventQueue()
        thread.turn += 1
        thread.written = ""
        thread.queue = queue
        this.queues.set(thread.sessionId, thread)
        if (thread.thought) thread.thought.prompts += 1
        await this.native.respond({
          sessionId: thread.sessionId,
          turn: thread.turn,
          prompt,
          options: {
            ...(temperature !== undefined && { temperature }),
            ...(tokens !== undefined && { maximumResponseTokens: tokens }),
            ...(this.samplingOf(options) && { sampling: this.samplingOf(options) }),
            ...(toolCallingMode && { toolCallingMode })
          }
        })
        return queue
      }

      // With reasoning (see reasoning.ts), the step thinks before it replies: working
      // notes first, streamed as reasoning, then the reply, both from the thread's
      // session. It thinks at a new message, and again at each tool's results. The
      // notes stay in the session while the turn goes on, and all come out of it once
      // the turn's reply is done (`thread.thought`).
      const reasoningId = nextId("reasoning")
      let notes = ""
      const noteEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        if (!notes) {
          yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
          yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
        }
        notes += delta
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta, model, timestamp: timestamp() }
      }
      const endNotes = function* (): Generator<AdapterYieldChunk> {
        if (!notes) return
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
        yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
      }
      type Drafted = Extract<NativeEvent, { type: "done" | "toolCalls" }>
      /** A response read as notes: to its end, or to the tool calls it makes instead. */
      const readNotes = async function* (queue: EventQueue): AsyncGenerator<AdapterYieldChunk, Drafted> {
        let ended: Drafted | undefined
        try {
          while (!ended) {
            const event = await queue.next(signal)
            if (event.type === "delta") yield* noteEvents(event.text)
            else if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code })
            else if (event.type === "stopped") throw new Error("The notes' response was ended at tool calls nobody asked it to end at")
            else {
              // Any of the notes not sent as deltas.
              if (event.type === "done" && event.text.startsWith(notes)) yield* noteEvents(event.text.slice(notes.length))
              ended = event
            }
          }
        } catch (error) {
          yield* endNotes()
          throw error
        }
        yield* endNotes()
        return ended
      }
      // The budget caps the notes; `maximumResponseTokens` covers the notes and the reply together.
      const draftTokens = !thinking ? max : thinking.budget === undefined ? max : max === undefined ? thinking.budget : Math.min(thinking.budget, max)
      // Whether the notes and their prompt come back out of the session before the reply: where the session's
      // own conversation can be changed (iOS/macOS 27), which keeps what it has read. Elsewhere they stay for
      // the reply: taking them out would be another session, and AFM 2 Core (an iPad on iOS 26) did far worse
      // handed its notes back in a prompt than left with them as its own turn (6 of 42 cases to 25).
      const takes = thinking ? await this.editsTranscript() : false
      // A tool's results get notes where the turn began with them, in this session, and the native side can
      // end the response that waits for the results at its calls: the notes are then a response of their own,
      // as a message's are. (Handed back into the waiting response with the ask for notes after them, the
      // results were just answered: a Mac's model wrote its answer as the notes 12 times in 12.)
      const stops = !!step.results && !!thinking && !!thread.thought && canStop
      let drafted: Drafted | undefined
      let message: string | undefined
      if (step.results) {
        if (stops && thread.thought) {
          const ending = thread.queue as EventQueue
          const results = step.results.map((result) => ({ callId: result.toolCallId as string, output: contentText(result.content) }))
          // Where the notes stayed in the session, so did the turn's asks. A native side that makes a new session
          // here (before iOS/macOS 27) leaves them out of it: the user's message, then the notes and the calls.
          const { prompts, message: asked } = thread.thought
          const tidies = !takes && prompts > 0
          await this.native.finishToolCalls?.({ sessionId: thread.sessionId, results, ...(tidies && { prompts, ...(asked !== undefined && { prompt: asked }) }) })
          if (tidies) thread.thought.prompts = asked !== undefined ? 1 : 0
          for (const result of results) thread.waiting.delete(result.callId)
          const ended = await ending.next(signal)
          if (ended.type === "error") throw Object.assign(new Error(ended.message), { code: ended.code })
          if (ended.type !== "stopped") throw new Error(`The response went on (${ended.type}) instead of ending at its tool calls`)
          // The results are in the session's conversation, after the calls: the instruction alone asks about them.
          drafted = yield* readNotes(await respond(draftPrompt(undefined, draftInstruction(options.messages)), draftTokens, "disallowed"))
        } else {
          for (const result of step.results) {
            const callId = result.toolCallId as string
            thread.waiting.delete(callId)
            await this.native.submitToolResult({ sessionId: thread.sessionId, callId, output: contentText(result.content) })
          }
        }
      } else if (!thinking) {
        await respond(step.prompt ?? "", max, toolCallingModeOf(options))
      } else {
        message = step.prompt || undefined
        thread.thought = { prompts: 0, message }
        drafted = yield* readNotes(await respond(draftPrompt(message, draftInstruction(options.messages)), draftTokens, "disallowed"))
      }
      if (drafted?.type === "toolCalls") {
        // A call the notes' response made all the same (before iOS/macOS 27 the framework can't be told not to) is the step's.
        first = drafted
      } else if (drafted) {
        draftUsage = drafted.usage
        const left = max === undefined ? undefined : max - (drafted.usage?.outputTokens ?? 0)
        if (left !== undefined && left <= 0) {
          // Notes that used the cap up leave no reply.
          thread.queue = undefined
          this.queues.delete(thread.sessionId)
          thread.seen = keys
          const usage = usageOf(drafted.usage)
          yield { type: EventType.RUN_FINISHED, runId, threadId, model, timestamp: timestamp(), finishReason: "length", ...(usage && { usage }) }
          return
        }
        // The notes and their prompt come out, and the reply is to the message with the notes. Where they
        // stay (see `takes`), the reply is asked for after them.
        if (takes) {
          await this.native.trimTranscript?.({ sessionId: thread.sessionId, entries: 2 })
          if (thread.thought) thread.thought.prompts -= 1
        }
        await respond(takes ? thoughtsPrompt(message, notes) : REPLY_PROMPT, left, toolCallingModeOf(options))
      }

      // This step's text (its assistant message), and the events that write it.
      let text = ""
      const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        if (!text) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
        text += delta
        thread.written += delta
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content: text, model, timestamp: timestamp() }
      }
      const endText = function* (): Generator<AdapterYieldChunk> {
        if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      }
      const queue = thread.queue as EventQueue
      for (;;) {
        const event: NativeEvent = first ?? (await queue.next(signal))
        first = undefined
        if (event.type === "delta") {
          yield* textEvents(event.text)
        } else if (event.type === "toolCalls") {
          yield* endText()
          for (const call of event.calls) thread.waiting.add(call.id)
          yield* toolCallChunks(event.calls, messageId, model)
          // The response waits for the results, which the next step sends.
          thread.seen = keys
          paused = true
          // A session no thread keeps is still found by the step with the results.
          if (!step.kept) this.paused.set(step.key, thread)
          // The tokens of the pass that made the calls (the next step's pass reads their results), with a draft's before it.
          const usage = thinkingUsageOf(draftUsage, event.usage)
          yield { type: EventType.RUN_FINISHED, runId, threadId, model, timestamp: timestamp(), finishReason: "tool_calls", ...(usage && { usage }) }
          return
        } else if (event.type === "done") {
          // Any of the response not sent as deltas.
          if (event.text.startsWith(thread.written)) yield* textEvents(event.text.slice(thread.written.length))
          yield* endText()
          thread.queue = undefined
          this.queues.delete(thread.sessionId)
          thread.seen = [...keys, messageKey({ role: "assistant", content: text })]
          // A thinking turn's notes, out of the session's conversation: the message as the user sent it,
          // then the reply. (A native side that can't leaves them in, as they were.)
          if (thread.thought) {
            const { prompts, message } = thread.thought
            thread.thought = undefined
            if (prompts > 0) {
              await this.native.rewriteTurn?.({ sessionId: thread.sessionId, prompts, ...(message !== undefined && { prompt: message }) })?.catch(() => undefined)
            }
          }
          const usage = thinkingUsageOf(draftUsage, event.usage)
          yield {
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            model,
            timestamp: timestamp(),
            finishReason: "stop",
            ...(usage && { usage })
          }
          return
        } else if (event.type === "stopped") {
          throw new Error("The response was ended at tool calls nobody asked it to end at")
        } else {
          throw Object.assign(new Error(event.message), { code: event.code })
        }
      }
    } catch (error) {
      const aborted = !!signal?.aborted
      if (step) {
        if (aborted) void this.native.cancel({ sessionId: step.thread.sessionId }).catch(() => undefined)
        // A stopped or failed response leaves the session behind: the next step starts a new one.
        this.close(step.thread)
        if (this.threads.get(step.key) === step.thread) this.threads.delete(step.key)
        if (this.paused.get(step.key) === step.thread) this.paused.delete(step.key)
      }
      options.logger.errors("afm chatStream failed", { error, source: "afm.chatStream" })
      yield runError(error, aborted, runId, model)
    } finally {
      if (step) {
        step.thread.busy = false
        // A session no thread keeps ends with its step, unless its response waits for tools.
        if (!step.kept && !paused) this.close(step.thread)
      }
    }
  }

  /**
   * Structured output as events, for `chat({ outputSchema })`, streaming or not:
   * the events chat() would make around `structuredOutput()` itself, but with the
   * error's code. chat() keeps a run error's code only from its RUN_ERROR event,
   * and its own wrapper keeps only a parse failure's ("structured-output-parse-failed"),
   * so without this a guardrail violation lost its code.
   */
  async *structuredOutputStream(options: StructuredOutputOptions<AfmTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const { chatOptions } = options
    const runId = chatOptions.runId ?? nextId("run")
    const { threadId } = chatOptions
    const messageId = nextId("msg")
    const model = this.model
    yield { type: EventType.RUN_STARTED, runId, threadId, model, timestamp: Date.now() }
    let result: StructuredOutputResult<unknown>
    try {
      result = await this.structuredOutput(options)
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
   * A JSON answer for `chat({ outputSchema })`: a session holding the
   * conversation answers its last message, held to the schema by the
   * framework, and the answer comes back as the framework wrote it.
   */
  async structuredOutput(
    options: StructuredOutputOptions<AfmTextModelOptions>
  ): Promise<StructuredOutputResult<unknown>> {
    const { chatOptions, outputSchema } = options
    const signal = signalOf(chatOptions)
    signal?.throwIfAborted()
    await this.listen()
    const last = chatOptions.messages.at(-1)
    const prompted = last?.role === "user"
    const before = prompted ? chatOptions.messages.slice(0, -1) : chatOptions.messages
    const thread = await this.open(chatOptions, [], "", toNativeMessages(before))
    try {
      thread.turn = 1
      thread.queue = new EventQueue()
      this.queues.set(thread.sessionId, thread)
      const { temperature, maximumResponseTokens } = chatOptions.modelOptions ?? {}
      const include = chatOptions.modelOptions?.includeSchemaInPrompt ?? this.includeSchemaInPrompt
      await this.native.respond({
        sessionId: thread.sessionId,
        turn: 1,
        prompt: prompted ? contentText(last.content) : "",
        schema: toNativeSchema(outputSchema, "Answer"),
        options: {
          ...(temperature !== undefined && { temperature }),
          ...(maximumResponseTokens !== undefined && { maximumResponseTokens }),
          ...(this.samplingOf(chatOptions) && { sampling: this.samplingOf(chatOptions) }),
          ...(include === false && { includeSchemaInPrompt: false })
        }
      })
      for (;;) {
        const event = await thread.queue.next(signal)
        if (event.type === "done") {
          const usage = usageOf(event.usage)
          // The answer as the framework held it to the schema (a SyntaxError, TanStack's parse failure, if it isn't JSON).
          return { data: JSON.parse(event.text) as unknown, rawText: event.text, model: this.model, ...(usage && { usage }) }
        }
        if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code })
      }
    } finally {
      this.close(thread)
    }
  }
}

/**
 * A TanStack AI text adapter for Apple's on-device model, through the
 * Foundation Models framework (the Capacitor plugin on iOS, by default).
 * The model is Apple's system model ("system"), so naming it is optional.
 *
 * @example
 * ```ts
 * const adapter = afmText()
 * if ((await adapter.availability()) === "available") {
 *   chat({ adapter, messages, tools })
 * }
 * ```
 */
export function afmText(config?: AfmConfig): AfmTextAdapter
export function afmText(model: AfmChatModel, config?: AfmConfig): AfmTextAdapter
export function afmText(
  modelOrConfig?: AfmChatModel | AfmConfig,
  config: AfmConfig = {}
): AfmTextAdapter {
  return typeof modelOrConfig === "string"
    ? new AfmTextAdapter(config, modelOrConfig)
    : new AfmTextAdapter(modelOrConfig ?? {}, "system")
}
