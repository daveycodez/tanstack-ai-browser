import type { RunOptions } from "./runner.ts"
import type { BenchmarkReport, BenchmarkResult } from "./types.ts"

export const RUNTIME_CHANNEL = "mancala-benchmark-runtime/v1"
export type RuntimeOptions = Pick<
  RunOptions,
  | "opponent"
  | "repetitions"
  | "reasoningBudgetTokens"
  | "caseIds"
  | "promptVersion"
>
export type RuntimeCommand =
  | {
      channel: typeof RUNTIME_CHANNEL
      type: "run"
      id: string
      options: RuntimeOptions
    }
  | { channel: typeof RUNTIME_CHANNEL; type: "cancel"; id: string }
export type RuntimeEvent =
  | { channel: typeof RUNTIME_CHANNEL; type: "ready" }
  | {
      channel: typeof RUNTIME_CHANNEL
      type: "progress"
      id: string
      status: string
    }
  | {
      channel: typeof RUNTIME_CHANNEL
      type: "result"
      id: string
      result: BenchmarkResult
    }
  | {
      channel: typeof RUNTIME_CHANNEL
      type: "complete"
      id: string
      report: BenchmarkReport
    }
  | {
      channel: typeof RUNTIME_CHANNEL
      type: "error"
      id: string
      error: string
    }
export type RuntimeMessage = {
  origin: string
  source: unknown
  data: RuntimeEvent
}
export type RuntimeFrame = {
  contentWindow: {
    postMessage: (message: RuntimeCommand, origin: string) => void
  } | null
  remove: () => void
}
export type FrameEnvironment = {
  origin: string
  createFrame: (id: string) => RuntimeFrame
  appendFrame: (frame: RuntimeFrame) => void
  addMessageListener: (listener: (event: RuntimeMessage) => void) => void
  removeMessageListener: (listener: (event: RuntimeMessage) => void) => void
  readyTimeoutMs?: number
}
function browserEnvironment(): FrameEnvironment {
  return {
    origin: window.location.origin,
    createFrame(id) {
      const frame = document.createElement("iframe")
      frame.src = new URL("/bench-runtime", window.location.href).href
      frame.hidden = true
      frame.setAttribute("aria-hidden", "true")
      frame.dataset.benchmarkRuntime = id
      return frame
    },
    appendFrame: (frame) => document.body.append(frame as HTMLIFrameElement),
    addMessageListener: (listener) =>
      window.addEventListener("message", listener),
    removeMessageListener: (listener) =>
      window.removeEventListener("message", listener)
  }
}
/** Each private window owns a separate WebGL singleton. Prompt API stays in the parent. */
export function runBenchmarkInFrame(
  options: RunOptions,
  environment?: FrameEnvironment
): Promise<BenchmarkReport> {
  options.signal.throwIfAborted()
  if (options.opponent.model === "prompt-api")
    throw new Error("Prompt API benchmarks run in the main page.")
  const env = environment ?? browserEnvironment()
  return new Promise((resolve, reject) => {
    const { signal, onResult, onProgress } = options
    const request: RuntimeOptions = {
      opponent: options.opponent,
      repetitions: options.repetitions,
      reasoningBudgetTokens: options.reasoningBudgetTokens,
      caseIds: options.caseIds.slice(),
      promptVersion: options.promptVersion
    }
    const id = crypto.randomUUID(),
      frame = env.createFrame(id)
    let started = false,
      settled = false
    const finish = (report?: BenchmarkReport, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      signal.removeEventListener("abort", abort)
      env.removeMessageListener(message)
      frame.remove()
      if (report) resolve(report)
      else reject(error)
    }
    const abort = () => {
      frame.contentWindow?.postMessage(
        { channel: RUNTIME_CHANNEL, type: "cancel", id },
        env.origin
      )
      finish(
        undefined,
        signal.reason ?? new DOMException("Aborted", "AbortError")
      )
    }
    const message = (event: RuntimeMessage) => {
      if (
        settled ||
        event.origin !== env.origin ||
        event.source !== frame.contentWindow ||
        event.data?.channel !== RUNTIME_CHANNEL
      )
        return
      const data = event.data
      if (data.type === "ready") {
        if (started || signal.aborted) return
        started = true
        clearTimeout(readyTimer)
        frame.contentWindow?.postMessage(
          { channel: RUNTIME_CHANNEL, type: "run", id, options: request },
          env.origin
        )
      } else if (data.id === id && !signal.aborted) {
        if (data.type === "progress") onProgress?.(data.status)
        else if (data.type === "result") onResult?.(data.result)
        else if (data.type === "complete") finish(data.report)
        else if (data.type === "error") finish(undefined, new Error(data.error))
      }
    }
    const readyTimer = setTimeout(
      () =>
        finish(
          undefined,
          new Error("The isolated benchmark runtime could not start.")
        ),
      env.readyTimeoutMs ?? 30_000
    )
    signal.addEventListener("abort", abort, { once: true })
    env.addMessageListener(message)
    env.appendFrame(frame)
    if (signal.aborted) abort()
  })
}
