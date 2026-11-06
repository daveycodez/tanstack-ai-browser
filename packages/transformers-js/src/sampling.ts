import type { WorkerSampling } from "./protocol.js"

/** Mulberry32: a small seeded generator of numbers in [0, 1). */
function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createSampler({
  temperature,
  top_k,
  repetition_penalty,
  top_p = 1,
  seed
}: WorkerSampling, prepare?: (ids: Array<Array<bigint>>, data: Float32Array) => void) {
  const random = seed === undefined ? Math.random : seededRandom(seed)
  const seen = new Set<number>()
  let counted = 0
  return <T extends { data: ArrayLike<number | bigint> }>(inputIds: Array<Array<bigint>>, logits: T): T => {
    const ids = inputIds[0]
    const data = logits.data as Float32Array
    prepare?.(inputIds, data)
    for (; counted < ids.length; counted++) seen.add(Number(ids[counted]))
    if (repetition_penalty !== 1) {
      for (const token of seen) {
        const x = data[token]
        data[token] = x < 0 ? x * repetition_penalty : x / repetition_penalty
      }
    }
    // Every token when top-k doesn't narrow it (0, or the whole vocabulary):
    // a copy in one pass, as keeping the k largest costs a scan of the kept
    // per replacement, quadratic over a whole vocabulary.
    const all = !(top_k > 0 && top_k < data.length)
    const k = all ? data.length : top_k
    const keptIds = all ? null : new Int32Array(k)
    const kept = all ? data.slice() : new Float32Array(k).fill(-Infinity)
    if (keptIds) {
      // The k largest, in no order: replace the smallest kept when beaten.
      let smallest = 0
      for (let i = 0; i < data.length; i++) {
        const x = data[i]
        if (x <= kept[smallest]) continue
        kept[smallest] = x
        keptIds[smallest] = i
        smallest = 0
        for (let j = 1; j < k; j++) if (kept[j] < kept[smallest]) smallest = j
      }
    }
    const idOf = (j: number) => (keptIds ? keptIds[j] : j)
    let best = 0
    for (let j = 1; j < k; j++) if (kept[j] > kept[best]) best = j
    if (!Number.isFinite(kept[best])) throw new Error("No allowed token has a finite model score.")
    let chosen = idOf(best)
    if (temperature > 0) {
      const max = kept[best]
      let total = 0
      for (let j = 0; j < k; j++) {
        kept[j] = Math.exp((kept[j] - max) / temperature)
        total += kept[j]
      }
      // Top-p: the likeliest tokens until their share reaches top_p; the
      // rest can't be drawn.
      if (top_p < 1) {
        const order = Array.from({ length: k }, (_, j) => j).sort(
          (a, b) => kept[b] - kept[a]
        )
        let share = 0
        let cut = false
        for (const j of order) {
          if (cut) {
            total -= kept[j]
            kept[j] = 0
          } else {
            share += kept[j] / total
            cut = share >= top_p
          }
        }
      }
      let draw = random() * total
      for (let j = 0; j < k; j++) {
        draw -= kept[j]
        if (draw <= 0 && kept[j] > 0) {
          chosen = idOf(j)
          break
        }
      }
    }
    data.fill(-Infinity)
    data[chosen] = 0
    return logits
  }
}
