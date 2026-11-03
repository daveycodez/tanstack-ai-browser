import type { StandardStudyOptions, StandardStudyReport } from "./standard-study.ts"
export const STANDARD_CHANNEL = "checkers-standard-runtime/v1"
export type StandardCommand =
  | { channel: typeof STANDARD_CHANNEL; type: "run"; id: string; model: StandardStudyOptions["model"] }
  | { channel: typeof STANDARD_CHANNEL; type: "cancel"; id: string }
export type StandardEvent =
  | { channel: typeof STANDARD_CHANNEL; type: "ready" }
  | { channel: typeof STANDARD_CHANNEL; type: "progress"; id: string; message: string }
  | { channel: typeof STANDARD_CHANNEL; type: "complete"; id: string; report: StandardStudyReport }
  | { channel: typeof STANDARD_CHANNEL; type: "error"; id: string; error: string }
export function runStandardInFrame(options: StandardStudyOptions): Promise<StandardStudyReport> {
  options.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe"), id = crypto.randomUUID(), origin = window.location.origin
    const url = new URL("/behavior-runtime", window.location.href); url.searchParams.set("run", id)
    frame.src = url.href; frame.hidden = true; frame.title = `Standard engine study ${options.model}`
    let started = false, settled = false
    const finish = (report?: StandardStudyReport, error?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.signal.removeEventListener("abort", abort); window.removeEventListener("message", message); frame.remove()
      if (report) resolve(report); else reject(error)
    }
    const abort = () => { frame.contentWindow?.postMessage({ channel: STANDARD_CHANNEL, type: "cancel", id } satisfies StandardCommand, origin); finish(undefined, options.signal.reason) }
    const message = (event: MessageEvent<StandardEvent>) => {
      if (event.origin !== origin || event.source !== frame.contentWindow || event.data?.channel !== STANDARD_CHANNEL) return
      const data = event.data
      if (data.type === "ready") {
        if (started || options.signal.aborted) return
        started = true; clearTimeout(timer); frame.contentWindow?.postMessage({ channel: STANDARD_CHANNEL, type: "run", id, model: options.model } satisfies StandardCommand, origin)
      } else if (data.id === id && !options.signal.aborted) {
        if (data.type === "progress") options.onProgress?.(data.message)
        else if (data.type === "complete") finish(data.report)
        else if (data.type === "error") finish(undefined, new Error(data.error))
      }
    }
    const timer = setTimeout(() => finish(undefined, new Error("Standard engine runtime could not initialize.")), 30_000)
    options.signal.addEventListener("abort", abort, { once: true }); window.addEventListener("message", message); document.body.append(frame)
    if (options.signal.aborted) abort()
  })
}
