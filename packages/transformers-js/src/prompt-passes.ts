/**
 * Long prompts read in passes. A pass returns logits for each token it
 * reads when the model's export has no `num_logits_to_keep` input (LFM2.5's
 * has none): for 2,048 tokens and a 65,536-token vocabulary, about 1.35 GB
 * of GPU buffers (fp16 logits, their fp32 cast and the copy read back),
 * which an iPhone tab doesn't have. So a prompt longer than PROMPT_PASS
 * tokens is read into the cache PROMPT_PASS tokens a pass first, and
 * generate() reads the rest and answers. A model whose export has the input
 * reads the prompt in one pass (the handler checks), as passes cost speed:
 * each is a forward pass of its own (on a Mac, Chrome, LFM2.5 1.2B, 2,060
 * tokens: 3,493 prompt tokens/s in passes against 4,034 in one).
 * huggingface/transformers.js#1836
 * asks for this in generate() itself; remove this once it does
 * (daveycodez/tanstack-ai-browser#27 tracks it).
 */

/** Most prompt tokens read in one pass. */
export const PROMPT_PASS = 512

/** How a model's passes are run, for readInPasses. */
export type Passes<Cache> = {
  /** The tokens a cache holds, or undefined where it can't be told (no attention layers). */
  lengthOf: (cache: Cache) => number | undefined
  /** Reads the prompt's tokens up to `end` into the cache (past what it holds), returning the cache. */
  read: (end: number, cache: Cache | undefined) => Promise<Cache | undefined>
  dispose: (cache: Cache) => Promise<void>
  /** Whether the reply was stopped: no more passes. */
  stopped: () => boolean
}

/**
 * Reads a prompt of `length` tokens into `cache`, PROMPT_PASS tokens a pass,
 * until PROMPT_PASS or fewer are left, and returns the cache for generate().
 * A cache whose length can't be told is returned as it is (the prompt is
 * read in one pass, as before); a pass that doesn't leave exactly its tokens
 * in the cache gives up and returns no cache, so generate() reads the whole
 * prompt.
 */
export async function readInPasses<Cache>(length: number, cache: Cache | undefined, passes: Passes<Cache>): Promise<Cache | undefined> {
  const held = cache === undefined ? 0 : passes.lengthOf(cache)
  if (held === undefined) return cache
  let read = held
  while (length - read > PROMPT_PASS && !passes.stopped()) {
    const end = read + PROMPT_PASS
    cache = await passes.read(end, cache)
    if (cache === undefined || passes.lengthOf(cache) !== end) {
      if (cache !== undefined) await passes.dispose(cache).catch(() => undefined)
      return undefined
    }
    read = end
  }
  return cache
}
