/**
 * Spare GPU buffers, kept from one model step for the next. ONNX Runtime
 * runs with its own buffer cache in "lazyRelease" mode, which destroys every
 * buffer a step made once the step ends; the worker keeps them here instead
 * and hands them back to the next step's requests of the same size. Sizes
 * are rounded up (pooledSize) so that requests that grow a little each token
 * (attention keys and values, and everything sized by them) keep landing on
 * the same few sizes, and a spare the next step doesn't take is destroyed.
 */

/** Requests of up to this many bytes are all made this size. */
const MIN_POOLED_SIZE = 256

/**
 * The size a pooled buffer is made at: `size` rounded up to a quarter step
 * of its power of two (1, 1.25, 1.5 or 1.75 × 2^n bytes), at most 25% more,
 * and never past the next power of two, so a request within a power-of-two
 * size limit stays within it.
 */
export function pooledSize(size: number) {
  if (size <= MIN_POOLED_SIZE) return MIN_POOLED_SIZE
  const quarter = 2 ** Math.floor(Math.log2(size)) / 4
  return Math.ceil(size / quarter) * quarter
}

/**
 * Spares by key (size and usage). A spare put back during a step can be
 * taken until the end of the next one; then it's released for good.
 */
export class SparePool<T> {
  #spares = new Map<string, Array<{ item: T; size: number; step: number }>>()
  #step = 0
  /** Bytes held as spares. */
  bytes = 0

  constructor(private readonly release: (item: T) => void) {}

  /** A spare for `key`, or undefined if there's none. */
  take(key: string) {
    const entry = this.#spares.get(key)?.pop()
    if (!entry) return undefined
    this.bytes -= entry.size
    return entry.item
  }

  /** Keeps `item` (`size` bytes) as a spare for requests of `key`. */
  put(key: string, item: T, size: number) {
    const list = this.#spares.get(key) ?? []
    list.push({ item, size, step: this.#step })
    this.#spares.set(key, list)
    this.bytes += size
  }

  /** Ends a step: releases the spares it left untaken. */
  endStep() {
    for (const [key, list] of this.#spares) {
      const kept = list.filter((entry) => entry.step >= this.#step)
      if (kept.length === list.length) continue
      for (const entry of list) {
        if (entry.step >= this.#step) continue
        this.bytes -= entry.size
        this.release(entry.item)
      }
      if (kept.length > 0) this.#spares.set(key, kept)
      else this.#spares.delete(key)
    }
    this.#step++
  }

  /** Releases every spare. */
  clear() {
    for (const list of this.#spares.values()) {
      for (const entry of list) this.release(entry.item)
    }
    this.#spares.clear()
    this.bytes = 0
  }
}
