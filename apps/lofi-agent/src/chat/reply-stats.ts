/**
 * A reply's stats line from its runs of the model: token counts, prompt and
 * generation speeds, and time to first token (see generation-stats.ts for
 * where runs are recorded).
 */

/** One run of the model. Counts the source doesn't report are left out. */
export type GenerationStats = {
  /** Tokens of the prompt the model read (after earlier turns were trimmed). */
  inputTokens?: number
  /**
   * Input tokens served from a cache instead of being read again: 0 when the
   * whole prompt was read, left out where the adapter can't say.
   */
  cachedTokens?: number
  /** Tokens the model generated. */
  outputTokens?: number
  /** From sending the prompt to the first generated token, in ms. */
  firstTokenMs?: number
  /** From starting to read the prompt to the first generated token, in ms. */
  promptMs?: number
  /** From sending the prompt to the last generated token, in ms. */
  streamMs?: number
}

/** What the stats line shows for a reply. */
export type ReplyStats = {
  inputTokens?: number
  cachedTokens?: number
  outputTokens?: number
  totalTokens?: number
  /**
   * Prompt tokens per second over every run of the reply (each tool call's
   * too): their input tokens over the time each took to its first token,
   * whatever of them a cache held.
   */
  promptTokensPerSecond?: number
  tokensPerSecond?: number
  firstTokenSeconds?: number
}

const sum = (values: Array<number | undefined>) =>
  values.every((v) => v !== undefined)
    ? values.reduce<number>((a, b) => a + (b ?? 0), 0)
    : undefined

/** A reply's stats from its runs, in the order they ran. */
export function replyStatsOf(
  generations: Array<GenerationStats>
): ReplyStats | null {
  if (generations.length === 0) return null
  // The prompt of the last run is what the model last read.
  const last = generations.at(-1)
  const timed = generations.filter(
    (g) => g.outputTokens !== undefined && g.streamMs !== undefined
  )
  const streamTokens = sum(timed.map((g) => g.outputTokens)) ?? 0
  const streamMs = sum(timed.map((g) => g.streamMs)) ?? 0
  const lastTotal =
    last?.inputTokens !== undefined && last.outputTokens !== undefined
      ? last.inputTokens + last.outputTokens
      : undefined
  const firstTokenMs = generations[0].firstTokenMs
  // Prompt processing across the reply's runs: each one's input tokens, and
  // how long until its first token.
  const read = generations.filter(
    (g) => g.inputTokens !== undefined && g.promptMs !== undefined
  )
  const readTokens = sum(read.map((g) => g.inputTokens))
  const readMs = sum(read.map((g) => g.promptMs)) ?? 0
  const cached = generations.filter((g) => g.cachedTokens !== undefined)
  return {
    inputTokens: last?.inputTokens,
    // Tokens every run of the reply took from a cache instead of reading.
    cachedTokens:
      cached.length > 0 ? sum(cached.map((g) => g.cachedTokens)) : undefined,
    outputTokens: sum(generations.map((g) => g.outputTokens)),
    totalTokens: lastTotal,
    promptTokensPerSecond:
      readTokens !== undefined && readTokens > 0 && readMs > 0
        ? readTokens / (readMs / 1000)
        : undefined,
    // Tokens over the whole stream, prompt reading included (as assistant-ui counts them).
    tokensPerSecond:
      streamMs > 0 && streamTokens > 0 ? streamTokens / (streamMs / 1000) : undefined,
    firstTokenSeconds:
      firstTokenMs !== undefined ? firstTokenMs / 1000 : undefined
  }
}

const count = new Intl.NumberFormat("en-US")
const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
})

/** ["In 868", "Cached 512", "Out 214", "Total 1,082", "95.2 pp/s", "18.4 tok/s", "TTFT 2.1s"] */
export function replyStatsItems(stats: ReplyStats) {
  const n = (value: number | undefined, label: string) =>
    value !== undefined ? `${label} ${count.format(value)}` : null
  return [
    n(stats.inputTokens, "In"),
    n(stats.cachedTokens, "Cached"),
    n(stats.outputTokens, "Out"),
    n(stats.totalTokens, "Total"),
    stats.promptTokensPerSecond !== undefined
      ? `${oneDecimal.format(stats.promptTokensPerSecond)} pp/s`
      : null,
    stats.tokensPerSecond !== undefined
      ? `${oneDecimal.format(stats.tokensPerSecond)} tok/s`
      : null,
    stats.firstTokenSeconds !== undefined
      ? `TTFT ${oneDecimal.format(stats.firstTokenSeconds)}s`
      : null
  ].filter((item) => item !== null)
}

/** "In 868 · Cached 512 · Out 214 · Total 1,082 · 95.2 pp/s · 18.4 tok/s · TTFT 2.1s" */
export const formatReplyStats = (stats: ReplyStats) =>
  replyStatsItems(stats).join(" · ")
