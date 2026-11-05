import type { ReasoningRequest } from "@tanstack/ai"
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
export type DraftReasoningResult = { notes: string; usage: PromptApiReasoningUsage }

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

/** Two-pass adapter emulation, not hidden native model reasoning or native token control. */
export async function* draftReasoning(session: LanguageModelSession, input: LanguageModelInput, signal: AbortSignal | undefined, budget?: number): AsyncGenerator<string, DraftReasoningResult> {
  signal?.throwIfAborted()
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) throw new RangeError("reasoning.budgetTokens must be a nonnegative safe integer.")
  const began = performance.now()
  const usage = (tokens: number, exhausted: boolean): PromptApiReasoningUsage => ({ reasoningEmulated: true, reasoningTokenMeasurement: "context-usage", reasoningBudgetEnforcement: "best-effort", thinkingTokens: tokens, ...(budget !== undefined && { thinkingBudgetTokens: budget }), thinkingBudgetExhausted: exhausted, reasoningMs: performance.now() - began })
  if (budget === 0) return { notes: "", usage: usage(0, true) }
  let draft: LanguageModelSession | undefined
  let counter: LanguageModelSession | undefined
  const internal = new AbortController()
  const cancel = () => internal.abort(signal?.reason)
  signal?.addEventListener("abort", cancel, { once: true })
  let notes = ""
  let tokens = 0
  let reached = false
  try {
    draft = await session.clone({ signal })
    counter = await session.clone({ signal })
    const counting = counter
    const overhead = await counting.measureContextUsage("", { signal })
    const measure = async (text: string) => {
      signal?.throwIfAborted()
      return Math.max(0, (await counting.measureContextUsage(text, { signal })) - overhead)
    }
    const messages: LanguageModelMessage[] = typeof input === "string" ? [{ role: "user", content: input }] : input
    const stream = draft.promptStreaming([...messages, draftInstruction], { signal: internal.signal })
    try {
      for await (const piece of stream) {
        signal?.throwIfAborted()
        const parts = Array.isArray(piece) ? piece : [piece]
        const delta = parts.map(part => typeof part === "string" ? part : part.type === "text" ? String(part.value) : "").join("")
        if (!delta) continue
        const candidate = notes + delta
        let accepted = candidate
        let count = await measure(candidate)
        if (budget !== undefined && count > budget) {
          // Search by code point, retaining only measured-feasible prefixes. Token
          // counts need not be monotonic, so verify the chosen prefix afterward.
          const points = Array.from(candidate)
          let low = Array.from(notes).length
          let high = points.length
          accepted = notes
          count = tokens
          while (low <= high) {
            const middle = Math.floor((low + high) / 2)
            const prefix = points.slice(0, middle).join("")
            const size = await measure(prefix)
            if (size <= budget) { accepted = prefix; count = size; low = middle + 1 }
            else high = middle - 1
          }
          let acceptedPoints = Array.from(accepted)
          count = await measure(accepted)
          while (count > budget && acceptedPoints.length > Array.from(notes).length) {
            acceptedPoints = acceptedPoints.slice(0, -1)
            accepted = acceptedPoints.join("")
            count = await measure(accepted)
          }
          if (count > budget) throw new Error("The browser's reasoning token measurement changed unexpectedly.")
          reached = true
        }
        const emitted = accepted.slice(notes.length)
        notes = accepted
        tokens = count
        const stop = reached || (budget !== undefined && tokens >= budget)
        if (stop) {
          reached = true
          internal.abort(new DOMException("Emulated reasoning budget reached", "AbortError"))
        }
        if (emitted) yield emitted
        if (stop) break
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!reached) throw error
    }
    signal?.throwIfAborted()
    return { notes, usage: usage(tokens, reached) }
  } finally {
    signal?.removeEventListener("abort", cancel)
    if (!internal.signal.aborted) internal.abort()
    draft?.destroy()
    counter?.destroy()
  }
}
