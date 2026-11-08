/** Messages between the page and the embedder's worker. */

/** What the worker loads: MediaPipe's WebAssembly and the model's file. */
export type LoadRequest = {
  type: "load"
  /** The folder of MediaPipe's WebAssembly files. */
  wasmPath: string
  /** The model's TFLite file. */
  modelUrl: string
  delegate?: "CPU" | "GPU"
}

/** Texts to embed, one vector each, with MediaPipe's embedder options. */
export type EmbedRequest = {
  type: "embed"
  id: number
  texts: Array<string>
  l2Normalize: boolean
  quantize: boolean
}

export type WorkerRequest = LoadRequest | EmbedRequest

export type WorkerResponse =
  | {
      type: "progress"
      /** True when the model's file comes from Cache Storage. */
      cached: boolean
      loadedBytes: number
      /** Bytes of the model's file, when the server says. */
      totalBytes?: number
    }
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "embedded"; id: number; vectors: Array<Float32Array> }
  | { type: "embed-error"; id: number; message: string }
