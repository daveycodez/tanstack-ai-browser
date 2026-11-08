/** The adapter's options: at load time, and per `embed()` call. */

/** Options that apply when the embedder loads (see `loadModel`). */
export type MediaPipeEmbeddingConfig = {
  /**
   * MediaPipe's `baseOptions.delegate`: `"CPU"` or `"GPU"`, MediaPipe's
   * default (the CPU) otherwise. MediaPipe 1.2.2's TextEmbedder runs
   * Universal Sentence Encoder on the CPU (TFLite's XNNPACK, in WebAssembly)
   * either way: with `"GPU"` it still creates the CPU delegate and returns
   * the same vectors.
   */
  delegate?: "CPU" | "GPU"
  /**
   * The model's TFLite file, to serve it yourself (or another MediaPipe
   * text embedder model). By default, Google's own copy (the model's `file`
   * in `MEDIAPIPE_MODEL_META`).
   */
  modelAssetPath?: string
  /**
   * The folder MediaPipe's WebAssembly files are served from: the
   * `wasm/` folder of `@mediapipe/tasks-text`. By default, the installed
   * version's own folder on jsDelivr.
   */
  wasmPath?: string
}

/** Options for one `embed()` call, as its `modelOptions`. */
export type MediaPipeEmbeddingProviderOptions = {
  /**
   * L2-normalizes each vector to unit length (MediaPipe's `l2Normalize`).
   * Universal Sentence Encoder's vectors aren't unit length (about 11), so
   * turn it on to compare them by dot product. Off by default, unless
   * `quantize` is on.
   */
  l2Normalize?: boolean
  /**
   * Scalar-quantizes each vector to bytes (MediaPipe's `quantize`): each
   * number is then an integer from -128 to 127 (the byte, read as signed).
   * MediaPipe's quantization assumes unit-length vectors, so `l2Normalize`
   * is on with it unless set to false. Off by default.
   */
  quantize?: boolean
}
