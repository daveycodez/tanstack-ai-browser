/**
 * Output token limits, emulated. The Prompt API has no output cap (a prompt
 * takes only `signal`, `responseConstraint` and
 * `omitResponseConstraintInput`), so the adapter holds the reply to a limit
 * itself: used for `maxCompletionTokens` and the emulated reasoning's
 * thinking budget.
 *
 * Chrome runs one operation at a time per model, so the model can't count
 * text while it writes it. The limit is estimated during the generation
 * (from a ratio calibrated on the request before it starts), the generation
 * is stopped by an internal abort a little past the limit, and the text is
 * measured and trimmed exactly once the model is idle again.
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
  outputTokenMeasurement: "estimate-then-context-usage"
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
        outputTokenMeasurement: "estimate-then-context-usage",
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

/** A message's text, without its images or audio. */
type TextBearing = { content: string | ReadonlyArray<{ type: string; value?: unknown }> }

/** The text of a prompt input (or of messages), without images or audio. */
export function textOfInput(input: string | ReadonlyArray<TextBearing>): string {
  if (typeof input === "string") return input
  return input
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" && typeof part.value === "string" ? part.value : ""))
            .join("")
    )
    .filter(Boolean)
    .join("\n")
}

/**
 * Live emission stops once the estimate passes this share of the limit, or
 * once the text passes the limit in UTF-8 bytes. Text sent live can't be
 * taken back, so it must stay within the limit whatever the estimate says:
 * no token is shorter than a byte, so text of at most `limit` bytes holds at
 * most `limit` tokens, however much denser the reply is than the calibration
 * text. The share keeps longer limits from streaming up to the last token
 * live, where a low estimate would leave nothing to trim.
 */
export const LIVE_FRACTION = 0.75
/**
 * Generation is stopped once the estimate passes STOP_FACTOR × limit +
 * STOP_SLACK tokens: past the limit, so the exact trim afterwards finds the
 * limit's worth of text unless the reply holds a fifth fewer tokens per byte
 * than the calibration text (the estimate is then high by more than 1.25×).
 * The slack covers short limits, where a chunk or two of noise is a large
 * share; 8 tokens is about 0.15 s of Gemini Nano's decoding.
 */
export const STOP_FACTOR = 1.25
export const STOP_SLACK = 8
/** Calibration text shorter than this (UTF-8 bytes) is too noisy alone. */
const MIN_SAMPLE_BYTES = 64
/** Calibration measures at most this many characters of text. */
const MAX_SAMPLE_CHARS = 4000
/**
 * Calibrates when the conversation has almost no text ("hi"): measured with
 * the model's own tokenizer like any other text, never a fixed ratio.
 */
const REFERENCE_TEXT =
  "The quick brown fox jumps over the lazy dog, then rests in the warm afternoon sun while the farmer counts his sheep."

/**
 * The text a limit's tokens-per-byte ratio is calibrated on: the request's
 * own text first, then earlier messages (most recent first) while it's
 * under 64 bytes, then a fixed reference sentence if it still is.
 */
export function calibrationSample(texts: ReadonlyArray<string>): string {
  let sample = ""
  for (const text of texts) {
    if (!text) continue
    if (sample && utf8Bytes(sample) >= MIN_SAMPLE_BYTES) break
    sample = sample ? `${sample}\n${text}` : text
  }
  if (utf8Bytes(sample) < MIN_SAMPLE_BYTES) {
    sample = sample ? `${sample}\n${REFERENCE_TEXT}` : REFERENCE_TEXT
  }
  if (sample.length <= MAX_SAMPLE_CHARS) return sample
  const end = sample.charCodeAt(MAX_SAMPLE_CHARS - 1)
  return sample.slice(0, end >= 0xd800 && end < 0xdc00 ? MAX_SAMPLE_CHARS - 1 : MAX_SAMPLE_CHARS)
}

/** What a limiter kept, once the generation has stopped. */
export type LimitResult = {
  /** The text within the limit: everything sent live, and `held`. */
  text: string
  /** The part of `text` held back during generation, to send now. */
  held: string
  /** `text`'s tokens, measured. */
  tokens: number
  /**
   * The limit ended the text: the exact count reached it, or the limiter
   * stopped the generation (even if the estimate ran high and the count
   * fell short: the reply was still cut for the limit).
   */
  reached: boolean
  /** Text past the limit was dropped. */
  trimmed: boolean
}

/** Holds streamed text to a token limit without calling the model mid-stream. */
export type TokenLimiter = {
  /** All the text received so far. */
  readonly text: string
  /** The estimate passed the stop line: stop the generation. */
  readonly stopped: boolean
  /**
   * Takes the next piece of text and returns what can be sent live now
   * (all of it, or nothing once text is held back). Never calls the model.
   */
  push(delta: string): string
  /** Counts text toward the estimate that isn't sent as text (a tool call). */
  account(extra: string): void
  /**
   * Once the generation has stopped (the model is idle, so measuring is
   * instant): the exact count, trimmed to the longest prefix within the
   * limit, never shorter than what was already sent live.
   */
  finish(): Promise<LimitResult>
  /** Exact tokens of a text (call only while the model is idle). */
  measure(text: string): Promise<number>
}

/**
 * A limiter for one generation. Chrome runs one operation at a time per
 * model: `measureContextUsage` (on any session or clone) and `clone()` wait
 * until a generation in progress finishes, so nothing can be measured while
 * the model writes. Instead, before generating, `sample` (the request's
 * text) is measured to calibrate a bytes-per-token ratio; while generating,
 * tokens are estimated from UTF-8 bytes with it; once the generation has
 * stopped, `finish()` measures exactly and trims.
 *
 * Bytes per token, not characters: it varies much less across scripts (a
 * CJK character is 3 bytes and about a token; English runs about 4 bytes a
 * token), and no token is shorter than a byte, so the ratio's floor of 1 is
 * the hard bound tokens ≤ bytes.
 */
export async function tokenLimiter(
  session: LanguageModelSession,
  limit: number,
  sample: string,
  signal: AbortSignal | undefined
): Promise<TokenLimiter> {
  const options = signal ? [{ signal }] : []
  let overhead: number | undefined
  const measure = async (text: string) => {
    signal?.throwIfAborted()
    if (!text) return 0
    overhead ??= await session.measureContextUsage("", ...options)
    return Math.max(0, (await session.measureContextUsage(text, ...options)) - overhead)
  }
  const sampleTokens = limit > 0 ? await measure(sample) : 0
  const bytesPerToken = Math.max(1, utf8Bytes(sample) / Math.max(1, sampleTokens))
  const liveLine = LIVE_FRACTION * limit
  const stopLine = STOP_FACTOR * limit + STOP_SLACK
  let text = ""
  let emitted = ""
  let holding = false
  let bytes = 0
  let stopped = limit === 0
  const estimate = () => bytes / bytesPerToken
  const check = () => {
    if (estimate() >= stopLine) stopped = true
  }

  return {
    get text() { return text },
    get stopped() { return stopped },
    push(delta) {
      if (!delta) return ""
      text += delta
      bytes += utf8Bytes(delta)
      check()
      if (!holding && estimate() <= liveLine && bytes <= limit) {
        emitted += delta
        return delta
      }
      holding = true
      return ""
    },
    account(extra) {
      bytes += utf8Bytes(extra)
      holding = true
      check()
    },
    async finish() {
      const tokens = await measure(text)
      if (tokens <= limit) {
        return { text, held: text.slice(emitted.length), tokens, reached: stopped || tokens >= limit, trimmed: false }
      }
      // Over the limit: keep the longest prefix within it, searching by code
      // point from what was sent live. Token counts need not be monotonic in
      // the prefix, so the chosen prefix is verified afterwards.
      const points = Array.from(text)
      const start = Array.from(emitted).length
      let low = start
      let high = points.length - 1
      let accepted = emitted
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const prefix = points.slice(0, middle).join("")
        if ((await measure(prefix)) <= limit) {
          accepted = prefix
          low = middle + 1
        } else high = middle - 1
      }
      let acceptedPoints = Array.from(accepted)
      let count = await measure(accepted)
      while (count > limit && acceptedPoints.length > start) {
        acceptedPoints = acceptedPoints.slice(0, -1)
        accepted = acceptedPoints.join("")
        count = await measure(accepted)
      }
      return { text: accepted, held: accepted.slice(emitted.length), tokens: count, reached: true, trimmed: true }
    },
    measure
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
