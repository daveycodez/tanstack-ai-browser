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
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage, Tool } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputOptions, StructuredOutputResult } from "@tanstack/ai/adapters"

import { contentText, toNativeMessages } from "./messages.js"
import type { AfmChatModel } from "./model-meta.js"
import { Afm } from "./native.js"
import type { AfmGuardrails, AfmNative, NativeEvent, NativeMessage, NativeUsage, UnavailableReason } from "./native.js"
import { toNativeSchema } from "./schema.js"
import { parseJsonValue } from "./json-value.js"
import { schemaErrors } from "./validate.js"

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
}

/** Per-call `modelOptions`: the response's sampling and length, and the guardrails. */
export type AfmTextModelOptions = {
  temperature?: number
  /** Most tokens to generate. */
  maximumResponseTokens?: number
  /** Apple's guardrails for this request's session, over the adapter's `guardrails`. */
  guardrails?: AfmGuardrails
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

/**
 * When to call tools, added to the instructions of a session that has some.
 * Given tools and no word on when to use them, Apple's model on an iPhone
 * (iOS 27.2) calls one for every prompt, "Hi" and "What is 2 + 2?" included;
 * on a Mac it doesn't. With this, the iPhone's answered greetings, small talk,
 * math, explanations and writing itself, and called the weather, location and
 * web search tools for the weather, "here", current facts and the news. Told
 * only to answer such requests "directly", it refused to write poems ("I
 * cannot write a haiku"); naming poems, stories and emails as its own work
 * keeps it writing.
 */
const TOOL_USE =
  "Most requests need no tool: greetings and small talk, math, writing (poems, stories, emails), explanations and general knowledge. Answer those yourself, without calling a tool. Call a tool only for what you can't do yourself: information that changes or that you don't have, or something only a tool can do."

/** The framework's tool-calling mode for a step: "required" when a tool must be called ("required", or the one tool named). */
const toolCallingModeOf = (options: TextOptions<AfmTextModelOptions>) =>
  options.toolChoice === "required" || typeof options.toolChoice === "object" ? ("required" as const) : undefined

/** The system prompts, and when to call tools if the session has some. */
const instructionsOf = (options: TextOptions<AfmTextModelOptions>, tools: ReadonlyArray<Tool>) =>
  [...normalizeSystemPrompts(options.systemPrompts).map((p) => p.content), ...(tools.length > 0 ? [TOOL_USE] : [])]
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
    // 0 too: nothing was cached. Left out where the framework can't say.
    ...(usage.cachedTokens !== undefined && { promptTokensDetails: { cachedTokens: usage.cachedTokens } })
  }

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

const signalOf = (options: TextOptions<AfmTextModelOptions>) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

/**
 * A structured answer the model wrote as text (permissive guardrails' fallback,
 * which the framework didn't hold to the schema): its JSON value, if it fits the
 * schema. chat() validates only schemas with a Standard Schema validator, not
 * plain JSON Schema, so the adapter checks it here.
 */
function checkedAnswer(text: string, schema: unknown): unknown {
  let data: unknown
  try {
    data = parseJsonValue(text)
  } catch (error) {
    throw Object.assign(new Error(`Apple's model wrote no JSON for the schema (its answer, written as text past its guardrails, was ${JSON.stringify(text.slice(0, 120))})`, { cause: error }), { code: "invalidJson" })
  }
  const problems = schemaErrors(schema, data)
  if (problems.length > 0) {
    throw Object.assign(new Error(`Apple's model's answer, written as text past its guardrails, doesn't fit the schema: ${problems.slice(0, 5).join("; ")}`), { code: "schemaMismatch" })
  }
  return data
}

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
  MetadataByModality
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
  private listening: Promise<unknown> | undefined

  constructor(config: AfmConfig, model: AfmChatModel) {
    super({}, model)
    this.native = config.native ?? (globalThis as { afm?: AfmNative }).afm ?? Afm
    this.guardrails = config.guardrails
  }

  private readonly guardrails: AfmGuardrails | undefined

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

  /** Tokens a session holds, where the OS says (26.4 and later). */
  async contextSize(): Promise<number | undefined> {
    try {
      return (await this.native.availability(this.guardrails ? { guardrails: this.guardrails } : undefined)).contextSize
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
   * thread keeps), each once.
   */
  async destroy(): Promise<void> {
    const all = new Set([...this.threads.values(), ...this.paused.values(), ...this.queues.values()])
    for (const thread of all) this.close(thread)
    this.threads.clear()
    this.paused.clear()
  }

  /** Routes the native events to their thread's response. Listens once. */
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
    const instructions = instructionsOf(options, tools)
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
      instructionsOf(options, tools),
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
      if (step.results) {
        for (const result of step.results) {
          const callId = result.toolCallId as string
          thread.waiting.delete(callId)
          await this.native.submitToolResult({ sessionId: thread.sessionId, callId, output: contentText(result.content) })
        }
      } else {
        const { temperature, maximumResponseTokens } = options.modelOptions ?? {}
        thread.turn += 1
        thread.written = ""
        thread.queue = new EventQueue()
        this.queues.set(thread.sessionId, thread)
        await this.native.respond({
          sessionId: thread.sessionId,
          turn: thread.turn,
          prompt: step.prompt ?? "",
          options: {
            ...(temperature !== undefined && { temperature }),
            ...(maximumResponseTokens !== undefined && { maximumResponseTokens }),
            ...(toolCallingModeOf(options) && { toolCallingMode: toolCallingModeOf(options) })
          }
        })
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
        const event = await queue.next(signal)
        if (event.type === "delta") {
          yield* textEvents(event.text)
        } else if (event.type === "toolCalls") {
          yield* endText()
          for (const [index, call] of event.calls.entries()) {
            thread.waiting.add(call.id)
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
          // The response waits for the results, which the next step sends.
          thread.seen = keys
          paused = true
          // A session no thread keeps is still found by the step with the results.
          if (!step.kept) this.paused.set(step.key, thread)
          yield { type: EventType.RUN_FINISHED, runId, threadId, model, timestamp: timestamp(), finishReason: "tool_calls" }
          return
        } else if (event.type === "done") {
          // Any of the response not sent as deltas.
          if (event.text.startsWith(thread.written)) yield* textEvents(event.text.slice(thread.written.length))
          yield* endText()
          thread.queue = undefined
          this.queues.delete(thread.sessionId)
          thread.seen = [...keys, messageKey({ role: "assistant", content: text })]
          const usage = usageOf(event.usage)
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
      const message = error instanceof Error ? error.message : String(error)
      const code = aborted ? "aborted" : (error as { code?: unknown })?.code
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: timestamp(),
        message,
        error: { message, ...(typeof code === "string" && { code }) }
      }
    } finally {
      if (step) {
        step.thread.busy = false
        // A session no thread keeps ends with its step, unless its response waits for tools.
        if (!step.kept && !paused) this.close(step.thread)
      }
    }
  }

  /**
   * A JSON answer for `chat({ outputSchema })`: a session holding the
   * conversation answers its last message, held to the schema by the
   * framework. `chat()` validates the result.
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
      await this.native.respond({
        sessionId: thread.sessionId,
        turn: 1,
        prompt: prompted ? contentText(last.content) : "",
        schema: toNativeSchema(outputSchema, "Answer"),
        options: {
          ...(temperature !== undefined && { temperature }),
          ...(maximumResponseTokens !== undefined && { maximumResponseTokens })
        }
      })
      for (;;) {
        const event = await thread.queue.next(signal)
        if (event.type === "done") {
          const usage = usageOf(event.usage)
          return { data: event.asText ? checkedAnswer(event.text, outputSchema) : (JSON.parse(event.text) as unknown), rawText: event.text, model: this.model, ...(usage && { usage }) }
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
