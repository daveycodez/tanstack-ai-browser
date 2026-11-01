/**
 * How a prompt is cut into model steps. WebKit crashes its GPU process when
 * a command buffer hasn't finished 3 s after it was sent, and ONNX Runtime
 * sends a whole step's work at once (microsoft/onnxruntime#33753), so every
 * step must finish well inside that: an 868-token step crashed an iPhone,
 * and 256-token steps late in a 7,600-token prompt took ~2.6 s there. A Mac
 * reads 256 tokens in ~0.1 s. So steps are sized from how fast the last one
 * went, the same way for every model and device.
 */

/** How long one step of reading a prompt should take. */
export const PROMPT_STEP_MS = 1500
/** Tokens in a step before any has been timed, which an iPhone handles. */
export const FIRST_PROMPT_STEP = 256
/** Steps shorter than this are mostly fixed costs, too short to time. */
export const MIN_PROMPT_STEP = 32
export const MAX_PROMPT_STEP = 1024

/**
 * Tokens for the next prompt step: what `rate` (tokens per ms of the last
 * timed step, null before any) reads in PROMPT_STEP_MS, at most double the
 * `previous` step (null for a prompt's first), and a prompt starts at no
 * more than twice FIRST_PROMPT_STEP: one fast step can be a fluke.
 */
export function nextPromptStep(previous: number | null, rate: number | null) {
  if (rate === null) return FIRST_PROMPT_STEP
  const fit = Math.round(rate * PROMPT_STEP_MS)
  const cap = Math.min((previous ?? FIRST_PROMPT_STEP) * 2, MAX_PROMPT_STEP)
  return Math.max(MIN_PROMPT_STEP, Math.min(fit, cap))
}

/**
 * Where a step of `step` tokens from `at` ends: at `end` at the latest, and
 * at the first of `stops` (positions the cache is wanted at) on the way.
 */
export function promptStepEnd(
  at: number,
  step: number,
  end: number,
  stops: Array<number>
) {
  const stop = Math.min(at + step, end)
  return stops.find((s) => s > at && s < stop) ?? stop
}
