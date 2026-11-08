/** What `untilAborted` resolves to when `signal` aborts first. */
export const ABORTED: unique symbol = Symbol("aborted")

/**
 * `promise`'s result, or `ABORTED` as soon as `signal` aborts, whichever
 * comes first: a run stops waiting at once, while what it waited for (a
 * model download other runs share, say) goes on.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}
