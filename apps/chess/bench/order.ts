import type { BenchmarkCase } from "./types.ts"

/** Keep the recorded pair, then use reproducible novel orders for confirmation. */
export function benchmarkOrder(
  testCase: BenchmarkCase,
  repetition: number
): string[] {
  if (repetition < testCase.orders.length)
    return [...testCase.orders[repetition]]
  let seed = 2166136261
  for (const character of `${testCase.id}:${repetition}`)
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0
  const order = [...testCase.orders[0]]
  for (let index = order.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const other = Math.floor((seed / 4294967296) * (index + 1))
    ;[order[index], order[other]] = [order[other], order[index]]
  }
  return order
}
