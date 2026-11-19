/**
 * Long prompts read in passes, each small enough for two limits:
 *
 * - Time. Safari kills its GPU process when a WebGPU command buffer hasn't
 *   completed 3 s after it was submitted (WebKit's Queue::commitMTLCommandBuffer),
 *   and ONNX Runtime submits a whole forward pass at once, so a pass's later
 *   command buffers wait behind its earlier ones: on an iPhone, LFM3 1.7B's
 *   521-token prompt in one pass crossed 3 s and the page lost its GPU
 *   (microsoft/onnxruntime#33753). Each pass ends with its logits read back,
 *   which drains the queue, so a pass is sized from how long the last ones
 *   took, to take about PASS_MS: few large passes on a fast GPU, small ones on
 *   a phone (and smaller as it heats up).
 * - Memory. A pass returns logits for each token it reads when the model's
 *   export has no `num_logits_to_keep` input (LFM2.5 1.2B's, Qwen3.5's): for
 *   2,048 tokens and a 65,536-token vocabulary, about 1.35 GB of GPU buffers.
 *   Such a model's passes are LOGITS_PASS tokens at most.
 *
 * The prompt is read into the cache pass by pass, then generate() reads the
 * rest and answers. huggingface/transformers.js#1836 asks for chunked prompt
 * reading in generate() itself; remove this once it does
 * (daveycodez/tanstack-ai-browser#27 tracks it).
 */

/** A pass's target time: a third of Safari's 3 s. */
export const PASS_MS = 1000

/** The first pass, before any speed is known. */
export const FIRST_PASS = 128

/** The smallest pass. */
export const MIN_PASS = 32

/** Most tokens a pass of a model without `num_logits_to_keep` reads. */
export const LOGITS_PASS = 512

/**
 * The next pass's tokens: about PASS_MS at `msPerToken` (FIRST_PASS while
 * it's unknown), MIN_PASS at least, `cap` at most.
 */
export function passSize(msPerToken: number | undefined, cap: number): number {
  const size = msPerToken === undefined || msPerToken <= 0 ? FIRST_PASS : Math.floor(PASS_MS / msPerToken)
  return Math.max(MIN_PASS, Math.min(cap, size))
}

/** How a model's passes are run, for readInPasses. */
export type Passes<Cache> = {
  /** The tokens a cache holds, or undefined where it can't be told (no attention layers). */
  lengthOf: (cache: Cache) => number | undefined
  /** Reads the prompt's tokens up to `end` into the cache (past what it holds), returning the cache. */
  read: (end: number, cache: Cache | undefined) => Promise<Cache | undefined>
  dispose: (cache: Cache) => Promise<void>
  /** Whether the reply was stopped: no more passes. */
  stopped: () => boolean
  /** Most tokens a pass reads (LOGITS_PASS, or Infinity for a model with `num_logits_to_keep`). */
  cap: number
  /** The model's prompt speed so far, in milliseconds a token, if known. */
  msPerToken: number | undefined
  /** Hears each pass's speed. */
  measured: (msPerToken: number) => void
  now?: () => number
}

/**
 * Reads a prompt of `length` tokens into `cache` in passes (sized by
 * passSize from the speed so far) until what's left fits in one, and returns
 * the cache for generate(). A cache whose length can't be told is returned
 * as it is (the prompt is read in one pass); a pass that doesn't leave
 * exactly its tokens in the cache gives up and returns no cache, so
 * generate() reads the whole prompt.
 */
export async function readInPasses<Cache>(length: number, cache: Cache | undefined, passes: Passes<Cache>): Promise<Cache | undefined> {
  const now = passes.now ?? (() => performance.now())
  const held = cache === undefined ? 0 : passes.lengthOf(cache)
  if (held === undefined) return cache
  let read = held
  let msPerToken = passes.msPerToken
  for (let size = passSize(msPerToken, passes.cap); length - read > size && !passes.stopped(); size = passSize(msPerToken, passes.cap)) {
    const end = read + size
    const started = now()
    cache = await passes.read(end, cache)
    if (cache === undefined || passes.lengthOf(cache) !== end) {
      if (cache !== undefined) await passes.dispose(cache).catch(() => undefined)
      return undefined
    }
    msPerToken = (now() - started) / size
    passes.measured(msPerToken)
    read = end
  }
  return cache
}
