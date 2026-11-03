import type { BenchmarkOptions } from "./runner.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"

export const RUNTIME_CHANNEL = "checkers-benchmark-runtime/v1"
export type RuntimeOptions = Omit<BenchmarkOptions, "signal" | "onResult" | "onProgress">
export type RuntimeCommand =
  | { channel: typeof RUNTIME_CHANNEL; type: "run"; id: string; options: RuntimeOptions }
  | { channel: typeof RUNTIME_CHANNEL; type: "cancel"; id: string }
export type RuntimeEvent =
  | { channel: typeof RUNTIME_CHANNEL; type: "ready" }
  | { channel: typeof RUNTIME_CHANNEL; type: "progress"; id: string; status: string }
  | { channel: typeof RUNTIME_CHANNEL; type: "result"; id: string; result: BenchmarkResult }
  | { channel: typeof RUNTIME_CHANNEL; type: "complete"; id: string; report: BenchmarkReport }
  | { channel: typeof RUNTIME_CHANNEL; type: "error"; id: string; error: string }

/** A private same-tab window owns each WebGL singleton; native Prompt API stays in the parent. */
export function runBenchmarkInFrame(options: BenchmarkOptions): Promise<BenchmarkReport> {
  options.signal.throwIfAborted()
  if ((options.model === "prompt-api" || options.model === "apple-foundationmodel")) throw new Error("Native model benchmarks run in the main page.")
  return new Promise((resolve, reject) => {
    const { signal, onResult, onProgress, ...request } = options
    const id = crypto.randomUUID(), origin = window.location.origin
    const frame = document.createElement("iframe")
    const runtimeUrl = new URL("/bench-runtime", window.location.href)
    runtimeUrl.searchParams.set("run", id)
    frame.src = runtimeUrl.href
    frame.hidden = true
    frame.setAttribute("aria-hidden", "true")
    frame.dataset.benchmarkRuntime = id
    let started = false, settled = false
    const finish = (report?: BenchmarkReport, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      signal.removeEventListener("abort", abort)
      window.removeEventListener("message", message)
      frame.remove()
      if (report) resolve(report)
      else reject(error)
    }
    const abort = () => {
      frame.contentWindow?.postMessage({ channel: RUNTIME_CHANNEL, type: "cancel", id } satisfies RuntimeCommand, origin)
      finish(undefined, signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const message = (event: MessageEvent<RuntimeEvent>) => {
      if (event.origin !== origin || event.source !== frame.contentWindow || event.data?.channel !== RUNTIME_CHANNEL) return
      const data = event.data
      if (data.type === "ready") {
        if (started || signal.aborted) return
        started = true; clearTimeout(readyTimer)
        frame.contentWindow?.postMessage({ channel: RUNTIME_CHANNEL, type: "run", id, options: request } satisfies RuntimeCommand, origin)
      } else if (data.id === id && !signal.aborted) {
        if (data.type === "progress") onProgress?.(data.status)
        else if (data.type === "result") onResult(data.result)
        else if (data.type === "complete") finish(data.report)
        else if (data.type === "error") finish(undefined, new Error(data.error))
      }
    }
    const readyTimer = setTimeout(() => finish(undefined, new Error("The isolated benchmark runtime could not start.")), 30_000)
    signal.addEventListener("abort", abort, { once: true })
    window.addEventListener("message", message)
    document.body.append(frame)
    if (signal.aborted) abort()
  })
}
