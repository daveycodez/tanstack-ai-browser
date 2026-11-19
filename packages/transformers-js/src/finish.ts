/**
 * Why a generation stopped, as Transformers.js's `generate()` stopped it:
 * on an end-of-turn token, or out of `max_new_tokens`.
 */

/**
 * The end-of-turn ids `generate()` stops on: a request's own
 * `eos_token_id` over the model's `generation_config`, over the tokenizer's,
 * as generate() merges its settings.
 */
export function endOfTurnIds(...sources: Array<unknown>): Array<number> {
  const given = sources.find((source) => source !== undefined && source !== null)
  return [given].flat().filter((id): id is number => typeof id === "number")
}

/**
 * "length" when the reply ran out of tokens before an end-of-turn token,
 * else "stop": by the last token written, not by the count, which takes in
 * the end-of-turn token (one written as the last allowed token is a stop).
 */
export function finishReasonOf(ids: ReadonlyArray<number>, outputTokens: number, maxNewTokens: number, eos: ReadonlyArray<number>): "stop" | "length" {
  const ended = outputTokens > 0 && eos.includes(ids.at(-1) ?? -1)
  return !ended && outputTokens >= maxNewTokens ? "length" : "stop"
}
