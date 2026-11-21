/**
 * ONNX Runtime Web, loaded on demand, and the page's one loaded model: its
 * sessions run on WebGPU where the browser has a GPU adapter, else on the CPU
 * (WebAssembly). ONNX Runtime's WebGL backend can't run these models (it has
 * no int8 dequantization, among other ops), so it isn't tried.
 */
import type { InferenceSession } from "onnxruntime-web"

/** The onnxruntime-web version this package installs; its WebAssembly files load from the CDN at this version by default. */
export const ORT_VERSION = "1.31.1"

/** Where ONNX Runtime's WebAssembly files load from, unless `wasmPaths` says otherwise. */
export const DEFAULT_WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`

/** Where the model runs. */
export type OnnxBackend = "webgpu" | "wasm"

export type Ort = typeof import("onnxruntime-web")

let ortModule: Promise<Ort> | undefined
/** ONNX Runtime Web with its WebGPU backend (WebAssembly included), once. */
export function loadOrt(wasmPaths: string): Promise<Ort> {
  ortModule ??= import("onnxruntime-web/webgpu").then((ort) => {
    ort.env.wasm.wasmPaths = wasmPaths
    return ort as unknown as Ort
  })
  ortModule.catch(() => (ortModule = undefined))
  return ortModule
}

/** Whether the browser gives WebGPU an adapter. */
export async function hasWebGpu(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

/**
 * Sessions for a model's files, on one backend, one at a time so the peak
 * holds one model's copy, not both. Constant folding is off: it would turn
 * every int8 weight into a float32 copy at load, about four times the memory,
 * more than a phone gives a tab. The weights are dequantized as they're used.
 */
export async function createSessions<T extends string>(
  ort: Ort,
  files: Record<T, ArrayBuffer>,
  backend: OnnxBackend,
  overrides: InferenceSession.SessionOptions = {},
  webgpuOptions: Record<string, unknown> = {}
): Promise<Record<T, InferenceSession>> {
  const options: InferenceSession.SessionOptions = {
    graphOptimizationLevel: "all",
    extra: { optimization: { disable_specified_optimizers: "ConstantFolding" } },
    ...overrides,
    executionProviders: [backend === "webgpu" ? ({ name: "webgpu", ...webgpuOptions } as InferenceSession.ExecutionProviderConfig) : backend]
  }
  const sessions = {} as Record<T, InferenceSession>
  try {
    for (const [name, bytes] of Object.entries(files) as Array<[T, ArrayBuffer]>) {
      sessions[name] = await ort.InferenceSession.create(new Uint8Array(bytes), options)
    }
  } catch (error) {
    await Promise.all(Object.values<InferenceSession>(sessions).map((session) => session.release()))
    throw error
  }
  return sessions
}
