/**
 * The callers waiting on one shared model load: their progress callbacks
 * and how many still wait. A caller whose signal aborts stops waiting at
 * once and hears nothing more; when the last caller still waiting aborts,
 * the load is cancelled. (Kept in step with the same file in the other
 * runtime packages.)
 */

/** A download's progress, from 0 to 1. */
type ProgressCallback = (progress: number) => void

/** What an aborted `createSessionWithProgress()` rejects with. */
export function abortError(): DOMException {
  return new DOMException("The model load was aborted.", "AbortError")
}

/** Calls a progress callback; one that throws doesn't stop the load. */
export function callProgress(listener: ProgressCallback, progress: number) {
  try {
    listener(progress)
  } catch (error) {
    console.error(error)
  }
}

export type WaitOptions = {
  onDownloadProgress?: ProgressCallback
  signal?: AbortSignal
  /**
   * Whether this caller aborting last cancels the load (true by default).
   * A chat's own wait passes false: it stops waiting, and the download goes
   * on for the next chat.
   */
  cancels?: boolean
  /** What this caller rejects with when it aborts: an AbortError by default. */
  reason?: (signal: AbortSignal) => unknown
}

export class LoadWaiters {
  /** Each callback, with how many waiting callers use it: called once per report. */
  private readonly callbacks = new Map<ProgressCallback, number>()
  private waiting = 0
  private settled = false

  /** `cancel` stops the load: called when the last caller still waiting aborts. */
  constructor(private readonly cancel: () => void) {}

  /** Reports progress to the callers still waiting. */
  report(progress: number) {
    for (const listener of [...this.callbacks.keys()]) callProgress(listener, progress)
  }

  /** The load settled (ready, failed or replaced): nothing more to report or cancel. */
  settle() {
    this.settled = true
    this.callbacks.clear()
    this.waiting = 0
  }

  /**
   * `load`'s result for one more caller. Aborting `signal` rejects this
   * caller at once and stops its reports; if it was the last caller waiting
   * (and `cancels`), the load is cancelled. The promise is fine to leave
   * unawaited. Check the signal before starting the load: an aborted one
   * rejects here without waiting.
   */
  wait<T>(load: Promise<T>, options: WaitOptions = {}): Promise<T> {
    const { onDownloadProgress, signal, cancels = true, reason = abortError } = options
    if (signal?.aborted) return quiet(Promise.reject(reason(signal)))
    if (this.settled) return quiet(load)
    this.waiting++
    if (onDownloadProgress) {
      this.callbacks.set(onDownloadProgress, (this.callbacks.get(onDownloadProgress) ?? 0) + 1)
    }
    let left = false
    const leave = () => {
      if (left) return
      left = true
      if (this.settled) return
      this.waiting--
      if (!onDownloadProgress) return
      const count = (this.callbacks.get(onDownloadProgress) ?? 0) - 1
      if (count > 0) this.callbacks.set(onDownloadProgress, count)
      else this.callbacks.delete(onDownloadProgress)
    }
    if (!signal) {
      load.then(leave, leave)
      return quiet(load)
    }
    return quiet(
      new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          leave()
          reject(reason(signal))
          if (cancels && !this.settled && this.waiting === 0) this.cancel()
        }
        signal.addEventListener("abort", onAbort, { once: true })
        load.then(
          (value) => {
            signal.removeEventListener("abort", onAbort)
            leave()
            resolve(value)
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort)
            leave()
            reject(error)
          }
        )
      })
    )
  }
}

/** `promise`, with a rejection that's fine to leave unhandled. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}
