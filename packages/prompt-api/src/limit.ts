/**
 * Output token caps, emulated. The Prompt API has no output cap (a prompt
 * takes only `signal`, `responseConstraint` and
 * `omitResponseConstraintInput`), so the adapter counts the text as it
 * streams with the session's own tokenizer (`measureContextUsage` on a
 * separate clone, less the empty message's overhead) and stops generation
 * with an internal abort at the cap. Used for `maxCompletionTokens` and the
 * emulated reasoning's thinking budget.
 *
 * Measuring is kept rare: no token is ever shorter than a UTF-8 byte, so
 * while the bytes written since the last measurement can't reach the cap,
 * nothing is measured. Text well under the cap is never measured; near it,
 * each measurement narrows the gap, so a reply costs a handful of
 * measurements (about log(cap) at worst), not one per chunk.
 */
import type { LanguageModelSession } from "./types.js"

/** `maxCompletionTokens`, validated like the other adapters validate it. */
export function outputTokenLimit(options: { maxCompletionTokens?: number } | undefined) {
  const limit = options?.maxCompletionTokens
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError("maxCompletionTokens must be a nonnegative safe integer.")
  }
  return limit
}

/** `parallelToolCalls`, checked like the other adapters check it. */
export function parallelToolCalls(options: { parallelToolCalls?: boolean } | undefined) {
  const parallel = options?.parallelToolCalls
  if (parallel !== undefined && typeof parallel !== "boolean") {
    throw new TypeError("parallelToolCalls must be a boolean.")
  }
  return parallel
}

/** The cap's report in `usage.providerUsageDetails`, when a cap was set. */
export type PromptApiOutputLimitUsage = {
  outputTokenLimit: number
  outputTokenMeasurement: "context-usage"
  outputTokenLimitEnforcement: "best-effort"
  outputTokenLimitReached: boolean
}

export const outputLimitUsage = (
  limit: number | undefined,
  reached: boolean
): PromptApiOutputLimitUsage | undefined =>
  limit === undefined
    ? undefined
    : {
        outputTokenLimit: limit,
        outputTokenMeasurement: "context-usage",
        outputTokenLimitEnforcement: "best-effort",
        outputTokenLimitReached: reached
      }

/** The smaller of two optional limits. */
export const smallest = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b)

/** UTF-8 bytes of a string: an upper bound on its tokens. */
function utf8Bytes(text: string) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** Counts streamed text against a token limit. */
export type TokenMeter = {
  /** The text accepted so far: within the limit. */
  readonly text: string
  /** Whether the limit was reached; nothing more is accepted. */
  readonly reached: boolean
  /**
   * Takes the next piece of text and returns the part of it within the
   * limit (all of it, until the limit is reached).
   */
  push(delta: string): Promise<string>
  /** The accepted text's tokens (measured if it changed since last measured). */
  count(): Promise<number>
  destroy(): void
}

/**
 * A meter for text `session` writes: counting goes through a clone, since a
 * session busy writing can't measure. `limit` undefined counts only.
 */
export async function tokenMeter(
  session: LanguageModelSession,
  limit: number | undefined,
  signal: AbortSignal | undefined
): Promise<TokenMeter> {
  const counter = await session.clone({ signal })
  let overhead: number | undefined
  const measure = async (text: string) => {
    signal?.throwIfAborted()
    overhead ??= await counter.measureContextUsage("", { signal })
    return Math.max(0, (await counter.measureContextUsage(text, { signal })) - overhead)
  }
  let text = ""
  let reached = limit === 0
  // The last measurement: text up to `length` holds `tokens`.
  let measured = { length: 0, tokens: 0 }
  // An upper bound on the accepted text's tokens.
  let bound = 0

  return {
    get text() { return text },
    get reached() { return reached },
    async push(delta) {
      if (reached || !delta) return ""
      const candidate = text + delta
      if (limit === undefined) {
        text = candidate
        return delta
      }
      const ceiling = measured.tokens + utf8Bytes(candidate.slice(measured.length))
      if (ceiling <= limit) {
        text = candidate
        bound = ceiling
        return delta
      }
      let count = await measure(candidate)
      measured = { length: candidate.length, tokens: count }
      if (count <= limit) {
        text = candidate
        bound = count
        if (count === limit) reached = true
        return delta
      }
      // Over the limit: keep the longest prefix within it, searching by code
      // point. Token counts need not be monotonic in the prefix, so the chosen
      // prefix is verified afterwards.
      const points = Array.from(candidate)
      const start = Array.from(text).length
      let low = start
      let high = points.length
      let accepted = text
      count = bound
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const prefix = points.slice(0, middle).join("")
        const size = await measure(prefix)
        if (size <= limit) { accepted = prefix; count = size; low = middle + 1 }
        else high = middle - 1
      }
      let acceptedPoints = Array.from(accepted)
      count = await measure(accepted)
      while (count > limit && acceptedPoints.length > start) {
        acceptedPoints = acceptedPoints.slice(0, -1)
        accepted = acceptedPoints.join("")
        count = await measure(accepted)
      }
      // (At worst the text already accepted, which a byte bound let through.)
      measured = { length: accepted.length, tokens: count }
      const emitted = accepted.slice(text.length)
      text = accepted
      bound = count
      reached = true
      return emitted
    },
    async count() {
      if (measured.length !== text.length) {
        measured = { length: text.length, tokens: text ? await measure(text) : 0 }
      }
      return measured.tokens
    },
    destroy() { counter.destroy() }
  }
}

/**
 * An abort signal for one generation that follows the caller's (with its
 * reason) and that `stop()` aborts on its own, never touching the caller's.
 */
export function internalAbort(signal: AbortSignal | undefined, reason: string) {
  const internal = new AbortController()
  const cancel = () => internal.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener("abort", cancel, { once: true })
  return {
    signal: internal.signal,
    stop: () => internal.abort(new DOMException(reason, "AbortError")),
    dispose: () => signal?.removeEventListener("abort", cancel)
  }
}
