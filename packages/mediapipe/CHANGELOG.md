## Unreleased

### 🚀 Features

- New package: a TanStack AI embedding adapter for Google's MediaPipe TextEmbedder, shaped like TanStack's own embedding adapters (`@tanstack/ai-openai`'s and `@tanstack/ai-gemini`'s), for `embed()`. It runs the official `@mediapipe/tasks-text` 1.2.2 npm package, a dependency, unmodified and through its public API, in a Web Worker.
  - `mediaPipeEmbedding(model?, config?)` and `MediaPipeEmbeddingAdapter`; the model defaults to `"universal-sentence-encoder"`, Universal Sentence Encoder from Google's storage (6.1 MB, 100 dimensions). Text inputs only, one vector per item; `dimensions` other than the model's throws.
  - Load options (`MediaPipeEmbeddingConfig`): `delegate`, `modelAssetPath`, `wasmPath` (relative paths are relative to the page), and `cacheWasm: false` to load MediaPipe's WebAssembly from `wasmPath` without `blob:` URLs, for a strict Content Security Policy. Adapters with equivalent options share one worker; a load with other options waits for the requests on the previous worker. Per-call options (`MediaPipeEmbeddingProviderOptions`, as `modelOptions`): `l2Normalize` and `quantize`, set on the one embedder through MediaPipe's `setOptions()`; `quantize` normalizes too unless `l2Normalize: false`.
  - Runtime functions as in the other packages: `isSupported(model?)`, `loadModel(model, config?)`, `unloadModel(model?)`, `modelStatus(model)`, with download progress for the model's file.
  - MediaPipe's WebAssembly loads from jsDelivr at the installed version, and the model and WebAssembly are kept in Cache Storage once MediaPipe has loaded them, so later loads work offline; a load from the cache that fails is retried once from the network. Both load on cross-origin isolated pages.
  - `@tanstack-ai-browser/mediapipe/model-meta`: `MEDIAPIPE_EMBEDDING_MODELS`, `MEDIAPIPE_MODEL_META` and their types.
