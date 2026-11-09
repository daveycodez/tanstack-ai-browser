import type { ModelMessage, ReasoningRequest } from "@tanstack/ai"
import { calibrationSample, internalAbort, smallest, textOfInput, tokenLimiter } from "./limit.js"
import type { TokenLimiter } from "./limit.js"
import { contentText } from "./messages.js"
import type { LanguageModelInput, LanguageModelMessage, LanguageModelSession } from "./types.js"

export type PromptApiReasoning = { levels: "off" | "high"; budget: true }
export type PromptApiReasoningUsage = {
  reasoningEmulated: true
  reasoningTokenMeasurement: "context-usage"
  reasoningBudgetEnforcement: "best-effort"
  thinkingTokens: number
  thinkingBudgetTokens?: number
  thinkingBudgetExhausted: boolean
  reasoningMs: number
}
export type DraftReasoningResult = { notes: string; usage: PromptApiReasoningUsage; capReached: boolean }

export function promptReasoningOptions(request: ReasoningRequest | undefined) {
  const budget = request?.budgetTokens
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  if (request?.level !== undefined && request.level !== "off" && request.level !== "high") throw new RangeError("Prompt API emulated reasoning supports off or high.")
  return { enabled: request?.level === "high", budget }
}

/** The longest quote of the user's message the draft instruction carries. */
const QUOTE_CHARS = 500

/**
 * The draft's instruction, quoting the user's latest message: after a tool
 * result, the newest user message is this instruction itself, and small
 * models took it for the message to reply to.
 */
export function draftInstruction(messages: ReadonlyArray<ModelMessage>): LanguageModelMessage {
  const latest = [...messages].reverse().find((m) => m.role === "user")
  const text = latest ? contentText(latest.content).trim().replace(/\s+/g, " ") : ""
  const quote = text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text
  return {
    role: "user",
    content: `Now write notes for yourself before replying to the user's latest message${quote ? `, "${quote}"` : ""}: what's needed, what you already have, and what to do next. Don't call tools or write the reply yet.`
  }
}
export function withWorkingNotes(input: LanguageModelInput, notes: string): LanguageModelInput {
  if (!notes) return input
  const messages: LanguageModelMessage[] = typeof input === "string" ? [{ role: "user", content: input }] : input
  return [...messages, { role: "user", content: `Working notes to verify against the conversation:\n${notes}\nNow produce the final response or required tool call.` }]
}

/**
 * Two-pass adapter emulation, not hidden native model reasoning or native
 * token control. The draft stops at the thinking `budget` and at `cap`, the
 * output tokens left for the whole reply (`maxCompletionTokens`, which counts
 * the draft too), whichever comes first; `capReached` says the cap stopped it.
 * Under a limit, the draft is held to it as `tokenLimiter` holds any reply:
 * estimated while it streams, stopped a little past the limit, then measured
 * and trimmed exactly (the rest of the notes streams once the draft stops).
 */
export async function* draftReasoning(session: LanguageModelSession, input: LanguageModelInput, conversation: ReadonlyArray<ModelMessage>, signal: AbortSignal | undefined, budget?: number, cap?: number): AsyncGenerator<string, DraftReasoningResult> {
  signal?.throwIfAborted()
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  const began = performance.now()
  const limit = smallest(budget, cap)
  const usage = (tokens: number, exhausted: boolean): PromptApiReasoningUsage => ({ reasoningEmulated: true, reasoningTokenMeasurement: "context-usage", reasoningBudgetEnforcement: "best-effort", thinkingTokens: tokens, ...(budget !== undefined && { thinkingBudgetTokens: budget }), thinkingBudgetExhausted: exhausted, reasoningMs: performance.now() - began })
  if (limit === 0) return { notes: "", usage: usage(0, budget === 0), capReached: cap === 0 }
  let draft: LanguageModelSession | undefined
  let limiter: TokenLimiter | undefined
  const stopper = internalAbort(signal, "Emulated reasoning budget reached")
  try {
    draft = await session.clone({ signal })
    const messages: LanguageModelMessage[] = typeof input === "string" ? [{ role: "user", content: input }] : input
    const prompt = [...messages, draftInstruction(conversation)]
    // Calibrated while the model is idle; nothing is measured mid-draft.
    if (limit !== undefined) limiter = await tokenLimiter(session, limit, calibrationSample([textOfInput(prompt)]), signal)
    const stream = draft.promptStreaming(prompt, { signal: stopper.signal })
    let notes = ""
    try {
      for await (const piece of stream) {
        signal?.throwIfAborted()
        const parts = Array.isArray(piece) ? piece : [piece]
        const delta = parts.map(part => typeof part === "string" ? part : part.type === "text" ? String(part.value) : "").join("")
        if (!delta) continue
        if (!limiter) {
          notes += delta
          yield delta
          continue
        }
        const live = limiter.push(delta)
        if (limiter.stopped) stopper.stop()
        if (live) yield live
        if (limiter.stopped) break
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!limiter?.stopped) throw error
    }
    signal?.throwIfAborted()
    if (!limiter) return { notes, usage: usage(await notesTokens(session, notes, signal), false), capReached: false }
    // The draft has stopped: the model is idle, so the exact count is instant.
    const kept = await limiter.finish()
    if (kept.held) yield kept.held
    return { notes: kept.text, usage: usage(kept.tokens, kept.reached && limit === budget), capReached: kept.reached && limit === cap }
  } finally {
    stopper.dispose()
    // Stops a draft left unread.
    if (!stopper.signal.aborted) stopper.stop()
    draft?.destroy()
  }
}

/** Tokens of finished notes, less the empty message's overhead. */
async function notesTokens(session: LanguageModelSession, notes: string, signal: AbortSignal | undefined) {
  if (!notes) return 0
  const options = signal ? [{ signal }] : []
  const overhead = await session.measureContextUsage("", ...options)
  return Math.max(0, (await session.measureContextUsage(notes, ...options)) - overhead)
}
