/**
 * Thinking for Apple's model, which has no reasoning of its own: with
 * `chat({ reasoning: "high" })`, each step first drafts working notes and then
 * replies with them in hand. Two requests of the adapter's, not reasoning of
 * the model's, and neither is in the conversation `chat()` keeps. The prompts
 * are in the afm and Prompt API adapters' format.
 *
 * At a user's message, the draft's request ends with one user message, the
 * instruction above the message it asks about (`draftMessages`), and the
 * reply's with the message again and the notes under it (`replyMessages`).
 * After a tool's results, the instruction comes after them, and the reply's
 * request ends with the notes.
 *
 * A turn's notes stay for the turn: a step that brings a tool's results reads
 * the notes of the turn's earlier steps (`earlierNotes`), in its draft and in
 * its reply. The next turn reads none of them, and no step reads an earlier
 * step's instruction.
 *
 * A structured answer (`chat({ outputSchema })`) thinks first too: a chat
 * request without the schema drafts the notes, and the request held to the
 * schema answers with them (`thinkingAnswer`, `thinkingAnswerResult`).
 */
import { EventType } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage } from "@tanstack/ai"

/** What asks for the notes at a user's message, and after a tool's results (about them: asked about the message again, a model plans the call it has just made). */
const MESSAGE_INSTRUCTION =
  "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet."
const AFTER_TOOL_INSTRUCTION =
  "Now write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."
/** What asks for the notes before a structured answer: its draft has no tools, so the ask is about the answer alone. The afm adapter's. */
const ANSWER_INSTRUCTION =
  "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and how you'll work out the answer. Don't write the reply yet."

/** A message with text before its content and after it: one text for a text message, else more parts of it. */
function around(message: ModelMessage, before: string, after: string): ModelMessage {
  if (Array.isArray(message.content)) {
    return { ...message, content: [{ type: "text", content: before }, ...message.content, ...(after ? [{ type: "text" as const, content: after }] : [])] }
  }
  return { ...message, content: `${before}${message.content ?? ""}${after}` }
}

/** Whether a step starts a turn: its last message is the user's. */
export const startsTurn =(messages: ReadonlyArray<ModelMessage>) => messages.at(-1)?.role === "user"

/**
 * The draft's messages. At a user's message, that message becomes one with the
 * instruction above it: "Instructions:", the instruction (a step's, or a
 * structured answer's), a blank line, "Message:" and the message. After a
 * tool's results, the step's messages, then the turn's earlier notes and the
 * instruction under "Instructions:".
 */
export function draftMessages(messages: ReadonlyArray<ModelMessage>, earlier: ReadonlyArray<string>, instruction = MESSAGE_INSTRUCTION): Array<ModelMessage> {
  const last = messages.at(-1)
  if (last && startsTurn(messages)) return [...messages.slice(0, -1), around(last, `Instructions:\n${instruction}\n\nMessage:\n`, "")]
  return [...messages, ...earlierNotes(earlier), { role: "user", content: `Instructions:\n${AFTER_TOOL_INSTRUCTION}` }]
}

/** A turn's earlier notes, for a later step of it: a message of their own after the step's, under "Notes:", each step's notes after a blank line. */
export function earlierNotes(notes: ReadonlyArray<string>): Array<ModelMessage> {
  return notes.length > 0 ? [{ role: "user", content: `Notes:\n${notes.join("\n\n")}` }] : []
}

/**
 * The notes of each thread's turn in progress, a step's each. apfel keeps no conversation between
 * requests, so the adapter holds them from one step of a turn to the next.
 */
export type TurnNotes = Map<string, Array<string>>

/** The most turns left unfinished (a tool's results that never came) whose notes are held. */
const HELD_TURNS = 32

/**
 * The reply's messages. At a user's message, that message becomes one with the
 * notes under it: "Message:", the message, a blank line, "Notes:" and the
 * notes; without notes, the messages as they are. After a tool's results, the
 * step's messages, then the turn's notes under "Notes:" (without notes, just
 * an ask for the reply).
 */
export function replyMessages(messages: ReadonlyArray<ModelMessage>, notes: string): Array<ModelMessage> {
  const last = messages.at(-1)
  if (last && startsTurn(messages)) return notes ? [...messages.slice(0, -1), around(last, "Message:\n", `\n\nNotes:\n${notes}`)] : [...messages]
  return [...messages, { role: "user", content: notes ? `Notes:\n${notes}` : "Now reply." }]
}

/** One request to apfel, as the adapter under this one streams it. */
type Step<TOptions extends TextOptions> = (options: TOptions) => AsyncIterable<AdapterYieldChunk>

/** A finished request's usage, as the adapter under this one reports it. */
const usageOf = (usage: Extract<AdapterYieldChunk, { type: EventType.RUN_FINISHED }>["usage"]) => (Array.isArray(usage) ? undefined : usage)

/** The reply's usage with the draft's added; the draft's output is the step's reasoning tokens. */
function withDraftUsage(usage: TokenUsage | undefined, draft: TokenUsage | undefined): TokenUsage | undefined {
  if (!draft) return usage
  if (!usage) return { ...draft, completionTokensDetails: { ...draft.completionTokensDetails, reasoningTokens: draft.completionTokens } }
  return {
    ...usage,
    promptTokens: usage.promptTokens + draft.promptTokens,
    completionTokens: usage.completionTokens + draft.completionTokens,
    totalTokens: usage.totalTokens + draft.totalTokens,
    completionTokensDetails: { ...usage.completionTokensDetails, reasoningTokens: draft.completionTokens }
  }
}

/** A request's end: finished, or failed. */
type RunEnd = Extract<AdapterYieldChunk, { type: EventType.RUN_FINISHED | EventType.RUN_ERROR }>

/** The run a draft's RUN_STARTED starts: its ids, which the step's later run events carry. */
type Run = Pick<Extract<AdapterYieldChunk, { type: EventType.RUN_STARTED }>, "runId" | "threadId">

/**
 * `modelOptions` for the two requests of a step with thinking: `budget` caps
 * the notes, and the caller's `max_tokens` covers the notes and the reply.
 */
function capped<TOptions extends TextOptions>(options: TOptions, budget: number | undefined) {
  const limit = (options.modelOptions as { max_tokens?: number } | undefined)?.max_tokens
  const upTo = (max: number | undefined) => ({ ...options.modelOptions, ...(max !== undefined && { max_tokens: max }) })
  return {
    draft: upTo(budget === undefined ? limit : limit === undefined ? budget : Math.min(budget, limit)),
    /** The reply's, after a draft of this usage; undefined when the notes used up `max_tokens`, which leaves no tokens for a reply. */
    reply: (drafted: TokenUsage | undefined) => {
      if (limit === undefined) return upTo(undefined)
      const left = limit - (drafted?.completionTokens ?? 0)
      return left > 0 ? upTo(left) : undefined
    }
  }
}

/**
 * A draft's request. Its text streams as reasoning, and it returns the notes
 * with the event the request ended with: the caller's to pass on or not, since
 * a draft's end isn't always the run's. It returns the run its RUN_STARTED
 * started too, which is the step's.
 */
async function* draft<TOptions extends TextOptions>(step: Step<TOptions>, options: TOptions): AsyncGenerator<AdapterYieldChunk, { notes: string; end?: RunEnd; run?: Run }> {
  let notes = ""
  let reasoningId = ""
  let run: Run | undefined
  for await (const chunk of step(options)) {
    const { model, timestamp } = chunk
    switch (chunk.type) {
      case EventType.RUN_STARTED:
        run = { runId: chunk.runId, threadId: chunk.threadId }
        yield chunk
        continue
      case EventType.TEXT_MESSAGE_START:
        reasoningId = `${chunk.messageId}-reasoning`
        yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp }
        yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp }
        continue
      case EventType.TEXT_MESSAGE_CONTENT:
        notes += chunk.delta
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: chunk.delta, model, timestamp }
        continue
      case EventType.TEXT_MESSAGE_END:
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp }
        yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp }
        continue
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        return { notes, end: chunk, run }
      default:
        yield chunk
    }
  }
  return { notes, run }
}

/** A run event's ids in the draft's run: its run id, and its thread id where it has one. */
const inRun = (chunk: RunEnd, run: Run) => ({ runId: run.runId, ...(chunk.threadId !== undefined && { threadId: run.threadId }) })

/**
 * A reply's events in the run its draft started: without its own RUN_STARTED,
 * with the draft's run id on its RUN_FINISHED or RUN_ERROR, which end that
 * run, and with the draft's usage added to its own. After a draft that
 * started no run, the reply's run is the step's, as it is.
 */
async function* afterDraft(reply: AsyncIterable<AdapterYieldChunk>, drafted: TokenUsage | undefined, run: Run | undefined): AsyncIterable<AdapterYieldChunk> {
  for await (const chunk of reply) {
    if (chunk.type === EventType.RUN_STARTED) {
      if (!run) yield chunk
    } else if (chunk.type === EventType.RUN_FINISHED) {
      yield withUsage({ ...chunk, ...(run && inRun(chunk, run)) }, withDraftUsage(usageOf(chunk.usage), drafted))
    } else if (chunk.type === EventType.RUN_ERROR) {
      yield { ...chunk, ...(run && inRun(chunk, run)) }
    } else {
      yield chunk
    }
  }
}

/** A run event with this usage, if there is one. */
const withUsage = <TChunk extends RunEnd>(chunk: TChunk, usage: TokenUsage | undefined): TChunk => (usage ? { ...chunk, usage } : chunk)

/** The usage of notes that are all a step has: the draft's, its output as reasoning tokens. */
const notesUsage = (drafted: TokenUsage | undefined) => withDraftUsage(undefined, drafted)

/**
 * A step with thinking: the draft's text streams as reasoning, then the reply
 * streams as the step's own, in one run.
 *
 * The draft is sent with the step's tools, so its notes can plan one. apfel
 * has no way to show the model tools it may not call (`tool_choice: "none"`
 * leaves them out of the model's prompt), so a draft can come back as a tool
 * call: that call is the step's, as a call written in a draft is in the
 * Prompt API adapter, and no reply is asked for.
 *
 * It is sent without a structured answer's schema (`outputSchema`, which
 * `chat()` sends with every step of a structured answer with tools): the
 * schema is the reply's, and notes held to it would be an answer.
 *
 * `budget` caps the notes; the caller's `max_tokens` covers notes and reply,
 * and notes that use it up end the step with finish reason "length", without
 * a reply.
 *
 * `turns` holds the turn's notes from step to step: a step that brings a tool's
 * results reads the earlier steps' before its own, and a reply without a tool
 * call ends the turn.
 */
export async function* thinkingStep<TOptions extends TextOptions>(
  step: Step<TOptions>,
  options: TOptions,
  budget: number | undefined,
  turns: TurnNotes
): AsyncIterable<AdapterYieldChunk> {
  const thread = options.threadId
  const earlier = thread !== undefined && options.messages.at(-1)?.role === "tool" ? (turns.get(thread) ?? []) : []
  /** The turn's notes so far, held for its next step. */
  const hold = (noted: Array<string>) => {
    if (thread === undefined) return
    turns.delete(thread)
    turns.set(thread, noted)
    if (turns.size > HELD_TURNS) for (const oldest of turns.keys()) return void turns.delete(oldest)
  }
  const max = capped(options, budget)

  const { notes, end, run } = yield* draft(step, { ...options, outputSchema: undefined, messages: draftMessages(options.messages, earlier), modelOptions: max.draft })
  const noted = notes.trim() ? [...earlier, notes.trim()] : earlier
  // The draft's end isn't the run's, unless it failed, called a tool or was stopped.
  if (end?.type === EventType.RUN_ERROR) {
    yield end
    return
  }
  if (end && (end.finishReason === "tool_calls" || options.request?.signal?.aborted)) {
    // What it wrote before its call is the step's notes.
    if (end.finishReason === "tool_calls") hold(noted)
    yield end
    return
  }
  const drafted = end && usageOf(end.usage)
  const replying = max.reply(drafted)
  // Notes that used up `max_tokens` leave no tokens for a reply: the step ends with them, cut off at the cap, and ends the turn.
  if (!replying) {
    if (thread !== undefined) turns.delete(thread)
    if (end) yield withUsage({ ...end, finishReason: "length" }, notesUsage(drafted))
    return
  }

  hold(noted)
  for await (const chunk of afterDraft(step({ ...options, messages: replyMessages(options.messages, noted.join("\n\n")), modelOptions: replying }), drafted, run)) {
    // A reply without a tool call ends the turn: its notes are no later turn's.
    if (chunk.type === EventType.RUN_FINISHED && chunk.finishReason !== "tool_calls" && thread !== undefined) turns.delete(thread)
    yield chunk
  }
}

/** A structured answer's notes: its request's options, with the notes in its messages, the draft's usage and the run it started; or the error the notes end with. */
type Noted<TOptions> = { options: TOptions; drafted: TokenUsage | undefined; run: Run | undefined } | { failed: Extract<RunEnd, { type: EventType.RUN_ERROR }> }

/** Why a structured answer fails when its notes used up `max_tokens`. */
const NO_TOKENS_LEFT = "The notes before the structured answer used up max_tokens, which leaves no tokens for the answer: raise max_tokens, or cap the notes with reasoning's budgetTokens."

/**
 * The notes before a structured answer to a user's message. The draft is a
 * chat request without the answer's schema, which is the answer's alone, and
 * without tools, which the answer doesn't call; its text streams as
 * reasoning. The answer's messages are a reply's: the message again, with the
 * notes under it. `budget` and `max_tokens` cap the two requests as a step's,
 * and notes that used up `max_tokens` fail the answer with a "length" error,
 * in the draft's run.
 */
async function* answerNotes<TOptions extends TextOptions>(step: Step<TOptions>, options: TOptions, budget: number | undefined): AsyncGenerator<AdapterYieldChunk, Noted<TOptions>> {
  const max = capped(options, budget)
  const drafting = draftMessages(options.messages, [], ANSWER_INSTRUCTION)
  const { notes, end, run } = yield* draft(step, { ...options, tools: undefined, outputSchema: undefined, messages: drafting, modelOptions: max.draft })
  if (end?.type === EventType.RUN_ERROR) return { failed: end }
  const drafted = end && usageOf(end.usage)
  const answering = max.reply(drafted)
  if (!answering) {
    const usage = notesUsage(drafted)
    return {
      failed: {
        type: EventType.RUN_ERROR,
        ...(run && { runId: run.runId, ...(run.threadId !== undefined && { threadId: run.threadId }) }),
        model: end?.model ?? options.model,
        timestamp: Date.now(),
        message: NO_TOKENS_LEFT,
        code: "length",
        error: { message: NO_TOKENS_LEFT, code: "length" },
        ...(usage && { usage })
      }
    }
  }
  return { options: { ...options, messages: replyMessages(options.messages, notes.trim()), modelOptions: answering }, drafted, run }
}

/**
 * A structured answer with thinking, as events in one run: the notes stream
 * as reasoning, then `answer`, the request held to the schema, answers with
 * them in hand. A draft that fails ends the run with its error, and no answer
 * is asked for.
 */
export async function* thinkingAnswer<TOptions extends TextOptions>(
  step: Step<TOptions>,
  options: TOptions,
  budget: number | undefined,
  answer: Step<TOptions>
): AsyncIterable<AdapterYieldChunk> {
  const noted = yield* answerNotes(step, options, budget)
  if ("failed" in noted) yield noted.failed
  else yield* afterDraft(answer(noted.options), noted.drafted, noted.run)
}

/**
 * The same without events, for `structuredOutput()`: the notes aren't
 * streamed, the answer's usage has the draft's added, and notes that fail
 * throw their error, with its code and its usage.
 */
export async function thinkingAnswerResult<TOptions extends TextOptions, TResult extends { usage?: TokenUsage }>(
  step: Step<TOptions>,
  options: TOptions,
  budget: number | undefined,
  answer: (options: TOptions) => Promise<TResult>
): Promise<TResult> {
  const drafting = answerNotes(step, options, budget)
  let next = await drafting.next()
  while (!next.done) next = await drafting.next()
  const noted = next.value
  if ("failed" in noted) {
    const { message, code, usage } = noted.failed
    throw Object.assign(new Error(message), code !== undefined && { code }, usage !== undefined && { usage })
  }
  const result = await answer(noted.options)
  const usage = withDraftUsage(result.usage, noted.drafted)
  return { ...result, ...(usage && { usage }) }
}
