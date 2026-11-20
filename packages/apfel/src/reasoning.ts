/**
 * Thinking for Apple's model, which has no reasoning of its own: with
 * `chat({ reasoning: "high" })`, each step first drafts working notes and then
 * replies with them in hand. Two requests of the adapter's, not reasoning of
 * the model's, and neither is in the conversation `chat()` keeps. The prompts
 * are the afm and Prompt API adapters', in the same words.
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
 */
import { EventType } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelMessage, TextOptions, TokenUsage } from "@tanstack/ai"

/** What asks for the notes at a user's message, and after a tool's results (about them: asked about the message again, a model plans the call it has just made). */
const MESSAGE_INSTRUCTION =
  "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet."
const AFTER_TOOL_INSTRUCTION =
  "Now write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."

/** A message with text before its content and after it: one text for a text message, else more parts of it. */
function around(message: ModelMessage, before: string, after: string): ModelMessage {
  if (Array.isArray(message.content)) {
    return { ...message, content: [{ type: "text", content: before }, ...message.content, ...(after ? [{ type: "text" as const, content: after }] : [])] }
  }
  return { ...message, content: `${before}${message.content ?? ""}${after}` }
}

/** Whether a step starts a turn: its last message is the user's. */
const startsTurn = (messages: ReadonlyArray<ModelMessage>) => messages.at(-1)?.role === "user"

/**
 * The draft's messages. At a user's message, that message becomes one with the
 * instruction above it: "Instructions:", the instruction, a blank line,
 * "Message:" and the message. After a tool's results, the step's messages,
 * then the turn's earlier notes and the instruction under "Instructions:".
 */
export function draftMessages(messages: ReadonlyArray<ModelMessage>, earlier: ReadonlyArray<string>): Array<ModelMessage> {
  const last = messages.at(-1)
  if (last && startsTurn(messages)) return [...messages.slice(0, -1), around(last, `Instructions:\n${MESSAGE_INSTRUCTION}\n\nMessage:\n`, "")]
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
 * `budget` caps the notes; the caller's `max_tokens` covers notes and reply.
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
  const limit = (options.modelOptions as { max_tokens?: number } | undefined)?.max_tokens
  const capped = (max: number | undefined) => ({ ...options.modelOptions, ...(max !== undefined && { max_tokens: max }) })
  const draftLimit = budget === undefined ? limit : limit === undefined ? budget : Math.min(budget, limit)

  let notes = ""
  let drafted: TokenUsage | undefined
  let reasoningId = ""
  const drafting = draftMessages(options.messages, earlier)
  for await (const chunk of step({ ...options, messages: drafting, modelOptions: capped(draftLimit) })) {
    const { model, timestamp } = chunk
    switch (chunk.type) {
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
        // The draft's end isn't the run's, unless it called a tool or was stopped.
        if (chunk.finishReason === "tool_calls" || options.request?.signal?.aborted) {
          // What it wrote before its call is the step's notes.
          if (chunk.finishReason === "tool_calls") hold(notes.trim() ? [...earlier, notes.trim()] : earlier)
          yield chunk
          return
        }
        drafted = usageOf(chunk.usage)
        continue
      case EventType.RUN_ERROR:
        yield chunk
        return
      default:
        yield chunk
    }
  }

  const left = limit === undefined ? undefined : Math.max(1, limit - (drafted?.completionTokens ?? 0))
  const noted = notes.trim() ? [...earlier, notes.trim()] : earlier
  hold(noted)
  for await (const chunk of step({ ...options, messages: replyMessages(options.messages, noted.join("\n\n")), modelOptions: capped(left) })) {
    // The run started with the draft.
    if (chunk.type === EventType.RUN_STARTED) continue
    if (chunk.type === EventType.RUN_FINISHED) {
      // A reply without a tool call ends the turn: its notes are no later turn's.
      if (chunk.finishReason !== "tool_calls" && thread !== undefined) turns.delete(thread)
      const usage = withDraftUsage(usageOf(chunk.usage), drafted)
      yield { ...chunk, ...(usage && { usage }) }
    } else {
      yield chunk
    }
  }
}
