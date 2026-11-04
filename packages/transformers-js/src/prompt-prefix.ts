/** Exact matching tokens; leave the prompt's final token unread for its logits. */
export function reusablePrefixLength(saved: ArrayLike<number>, prompt: ArrayLike<number>): number {
  const limit = Math.max(0, Math.min(saved.length, prompt.length - 1))
  let common = 0
  while (common < limit && saved[common] === prompt[common]) common++
  return common
}

/** Tokenizer-only A/B fallback; the result is still intersected with the actual prompt. */
export function systemPrefixTokens<T extends { role: string; content: string }>(
  leading: ReadonlyArray<T>,
  encode: (messages: Array<T | { role: "user"; content: string }>) => ArrayLike<number>
): Array<number> {
  try { return Array.from(encode([...leading]), Number) }
  catch {
    try {
      const first = Array.from(encode([...leading, { role: "user", content: "A" }]), Number)
      const second = Array.from(encode([...leading, { role: "user", content: "B" }]), Number)
      let common = 0
      while (common < first.length && common < second.length && first[common] === second[common]) common++
      return first.slice(0, common)
    } catch { return [] }
  }
}
