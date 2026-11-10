/**
 * The page's side of the worker (worker.ts). One worker for the page, with
 * one model in it: loading another replaces it. The worker loads or
 * generates one thing at a time, so requests wait their turn.
 */
import type { GenerateRequest, LoadSettings, WorkerReply, WorkerRequest } from "./protocol.js"

/**
 * Where a model stands in this browser, with the Prompt API's values
 * (`LanguageModel.availability()`).
 */
export type Availability = "unavailable" | "downloadable" | "downloading" | "available"

/** A download's progress, from 0 to 1. */
export type DownloadProgressCallback = (progress: number) => void

let worker: Worker | null = null
/** Where the worker's replies go: the load or generation in progress. */
let listener: ((reply: WorkerReply) => void) | null = null
/** The model the worker holds or is loading. */
let current: {
  key: string
  model: string
  ready: boolean
  done: Promise<void>
  listeners: Set<DownloadProgressCallback>
} | null = null
let tail: Promise<unknown> = Promise.resolve()

function post(request: WorkerRequest) {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "transformers-js" })
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => listener?.(data)
    worker.onerror = (event) => {
      event.preventDefault()
      listener?.({ status: "error", message: event.message || "The Transformers.js worker failed to start." })
    }
  }
  worker.postMessage(request)
}

/** Waits for the worker's turn; call the release it resolves to when done. */
function turn(): Promise<() => void> {
  let release = () => undefined as void
  const held = new Promise<void>((resolve) => (release = resolve))
  const ready = tail.then(() => release)
  tail = tail.then(() => held)
  return ready
}

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")

/**
 * Loads a model in the worker (downloading it the first time) unless it's
 * the one there, sharing a load in progress. `onDownloadProgress` hears the
 * download's progress, then 1 once the model is ready (at once if it is).
 * Aborting `signal` stops this caller's wait, not the load.
 */
export function loadModel(
  settings: LoadSettings,
  onDownloadProgress?: DownloadProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  const key = JSON.stringify(settings)
  if (current?.key !== key) {
    const listeners = new Set<DownloadProgressCallback>()
    const load = { key, model: settings.model, ready: false, listeners, done: Promise.resolve() }
    load.done = (async () => {
      const release = await turn()
      try {
        await new Promise<void>((resolve, reject) => {
          listener = (reply) => {
            if (reply.status === "progress") for (const report of listeners) report(reply.progress)
            else if (reply.status === "ready") resolve()
            else if (reply.status === "error") reject(new Error(reply.message))
          }
          post({ type: "load", settings })
        })
        load.ready = true
        for (const report of listeners) report(1)
      } catch (error) {
        if (current === load) current = null
        throw error
      } finally {
        listeners.clear()
        listener = null
        release()
      }
    })()
    current = load
  }
  const load = current
  if (load.ready) {
    onDownloadProgress?.(1)
    return Promise.resolve()
  }
  if (onDownloadProgress) load.listeners.add(onDownloadProgress)
  if (!signal) return load.done
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      if (onDownloadProgress) load.listeners.delete(onDownloadProgress)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    load.done.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

/** Ends the worker, freeing the model's memory, if `model` is the one it holds. */
export function unloadModel(model: string) {
  if (current?.model !== model) return
  current = null
  worker?.terminate()
  worker = null
  listener?.({ status: "error", message: "The model was unloaded." })
}

/** Stops the generation in progress, which then completes with what it has. */
export function interrupt() {
  worker?.postMessage({ type: "interrupt" } satisfies WorkerRequest)
}

export type GenerationEvent =
  | { type: "text"; text: string }
  | { type: "done"; inputTokens: number; outputTokens: number }

/**
 * One generation in the worker, once it's free: the text as it streams,
 * then the token counts. Aborting `signal` interrupts it; it still
 * completes, with the text so far.
 */
export async function* generate(request: GenerateRequest, signal?: AbortSignal): AsyncGenerator<GenerationEvent> {
  const release = await turn()
  const replies: Array<WorkerReply> = []
  let wake: (() => void) | null = null
  let ended = false
  listener = (reply) => {
    replies.push(reply)
    wake?.()
  }
  const next = async () => {
    while (replies.length === 0) await new Promise<void>((resolve) => (wake = resolve))
    const reply = replies.shift() as WorkerReply
    if (reply.status === "complete" || reply.status === "error") ended = true
    return reply
  }
  signal?.addEventListener("abort", interrupt)
  try {
    post({ type: "generate", ...request })
    if (signal?.aborted) interrupt()
    for (;;) {
      const reply = await next()
      if (reply.status === "update") yield { type: "text", text: reply.output }
      else if (reply.status === "error") throw new Error(reply.message)
      else if (reply.status === "complete") {
        yield { type: "done", inputTokens: reply.inputTokens, outputTokens: reply.outputTokens }
        return
      }
    }
  } finally {
    signal?.removeEventListener("abort", interrupt)
    // A reader that stopped early: the worker finishes before the next request.
    if (!ended) {
      interrupt()
      while (!ended && worker) await next()
    }
    listener = null
    release()
  }
}

let webGpu: Promise<boolean> | undefined
/** Whether the browser has WebGPU and gives a GPU adapter, as the worker checks. */
function hasWebGpu(): Promise<boolean> {
  webGpu ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    try {
      return !!gpu && (await gpu.requestAdapter()) !== null
    } catch {
      return false
    }
  })()
  return webGpu
}

/** Whether Transformers.js's cache holds ONNX weights of `model`. */
async function inCache(model: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined" || !(await caches.has("transformers-cache"))) return false
    const keys = await (await caches.open("transformers-cache")).keys()
    return keys.some(({ url }) => url.includes(`/${model}/`) && /\.onnx(_data(_\d+)?)?$/.test(url))
  } catch {
    return false
  }
}

/**
 * Where `model` stands here: "unavailable" without a Web Worker and
 * WebAssembly (on a server), or without WebGPU unless it `runsOnCpu`;
 * "available" when it's loaded, "downloading" while it loads, "available"
 * when its weights are in Transformers.js's cache, else "downloadable".
 */
export async function availability(model: string, runsOnCpu: boolean): Promise<Availability> {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return "unavailable"
  if (!runsOnCpu && !(await hasWebGpu())) return "unavailable"
  if (current?.model === model) return current.ready ? "available" : "downloading"
  return (await inCache(model)) ? "available" : "downloadable"
}
