import type { ReasoningRequest } from "@tanstack/ai"
import { internalAbort, smallest, tokenMeter } from "./limit.js"
import type { TokenMeter } from "./limit.js"
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

const draftInstruction: LanguageModelMessage = {
  role: "user",
  content: "Write short working notes for the next response. Use facts already available in the conversation. Do not call tools or give the final response yet."
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
 */
export async function* draftReasoning(session: LanguageModelSession, input: LanguageModelInput, signal: AbortSignal | undefined, budget?: number, cap?: number): AsyncGenerator<string, DraftReasoningResult> {
  signal?.throwIfAborted()
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  const began = performance.now()
  const limit = smallest(budget, cap)
  const usage = (tokens: number, exhausted: boolean): PromptApiReasoningUsage => ({ reasoningEmulated: true, reasoningTokenMeasurement: "context-usage", reasoningBudgetEnforcement: "best-effort", thinkingTokens: tokens, ...(budget !== undefined && { thinkingBudgetTokens: budget }), thinkingBudgetExhausted: exhausted, reasoningMs: performance.now() - began })
  if (limit === 0) return { notes: "", usage: usage(0, budget === 0), capReached: cap === 0 }
  let draft: LanguageModelSession | undefined
  let meter: TokenMeter | undefined
  const stopper = internalAbort(signal, "Emulated reasoning budget reached")
  try {
    draft = await session.clone({ signal })
    meter = await tokenMeter(session, limit, signal)
    const messages: LanguageModelMessage[] = typeof input === "string" ? [{ role: "user", content: input }] : input
    const stream = draft.promptStreaming([...messages, draftInstruction], { signal: stopper.signal })
    try {
      for await (const piece of stream) {
        signal?.throwIfAborted()
        const parts = Array.isArray(piece) ? piece : [piece]
        const delta = parts.map(part => typeof part === "string" ? part : part.type === "text" ? String(part.value) : "").join("")
        if (!delta) continue
        const emitted = await meter.push(delta)
        if (meter.reached) stopper.stop()
        if (emitted) yield emitted
        if (meter.reached) break
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!meter.reached) throw error
    }
    signal?.throwIfAborted()
    const tokens = await meter.count()
    return { notes: meter.text, usage: usage(tokens, meter.reached && limit === budget), capReached: meter.reached && limit === cap }
  } finally {
    stopper.dispose()
    // Stops a draft left unread.
    if (!stopper.signal.aborted) stopper.stop()
    draft?.destroy()
    meter?.destroy()
  }
}
