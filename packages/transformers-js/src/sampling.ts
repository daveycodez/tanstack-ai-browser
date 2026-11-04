import type { Sampling } from "./protocol.js"

export function createSampler({
  temperature,
  top_k,
  repetition_penalty,
  top_p = 1
}: Sampling, prepare?: (ids: Array<Array<bigint>>, data: Float32Array) => void) {
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
    // The k largest, in no order: replace the smallest kept when beaten.
    const k = Math.max(
      1,
      Math.min(top_k > 0 ? top_k : data.length, data.length)
    )
    const keptIds = new Int32Array(k)
    const kept = new Float32Array(k).fill(-Infinity)
    let smallest = 0
    for (let i = 0; i < data.length; i++) {
      const x = data[i]
      if (x <= kept[smallest]) continue
      kept[smallest] = x
      keptIds[smallest] = i
      smallest = 0
      for (let j = 1; j < k; j++) if (kept[j] < kept[smallest]) smallest = j
    }
    let best = 0
    for (let j = 1; j < k; j++) if (kept[j] > kept[best]) best = j
    if (!Number.isFinite(kept[best])) throw new Error("No allowed token has a finite model score.")
    let chosen = keptIds[best]
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
      let draw = Math.random() * total
      for (let j = 0; j < k; j++) {
        draw -= kept[j]
        if (draw <= 0 && kept[j] > 0) {
          chosen = keptIds[j]
          break
        }
      }
    }
    data.fill(-Infinity)
    data[chosen] = 0
    return logits
  }
}
