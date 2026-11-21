/**
 * One queue for everything that touches the page's ONNX sessions: loading,
 * switching to another model or backend, drawing, unloading. Each task runs
 * after the one before has ended, so no task releases sessions another is
 * still using.
 */

let tail: Promise<unknown> = Promise.resolve()

/** The reason an aborted signal gives, as an error. */
const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError")

/**
 * Runs `task` after every task queued before it. A caller whose `signal` is
 * aborted while it waits rejects at once, and its task, when its turn
 * comes, rejects without running.
 */
export function serial<T>(
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const run = tail.then(() => {
    signal?.throwIfAborted()
    return task()
  })
  tail = run.catch(() => undefined)
  if (!signal) return run
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    run
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort))
  })
}
