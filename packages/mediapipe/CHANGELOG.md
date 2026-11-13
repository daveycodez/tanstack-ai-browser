## 0.2.0 (2026-11-13)

### 🚀 Features

- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- **mediapipe:** add an embedding adapter for MediaPipe's TextEmbedder ([34e9e4c](https://github.com/daveycodez/tanstack-ai-browser/commit/34e9e4c))

### 🩹 Fixes

- **wllama, mediapipe:** concurrent loads and destroy ([c8d2a8a](https://github.com/daveycodez/tanstack-ai-browser/commit/c8d2a8a))
- tell downloaded models apart in availability(), without constructor side effects ([eb8c2d5](https://github.com/daveycodez/tanstack-ai-browser/commit/eb8c2d5))
- **mediapipe:** cache files only once they load, and keep requests through a worker switch ([122017e](https://github.com/daveycodez/tanstack-ai-browser/commit/122017e))

### ⚠️  Breaking Changes

- the catalogs are exported from each package's root  ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
  import the catalogs from the package root, not from
  its ./model-meta subpath.

### ❤️ Thank You

- daveycodez

## Unreleased

### 🚀 Features

- New package: a TanStack AI embedding adapter for Google's MediaPipe TextEmbedder, shaped like TanStack's own embedding adapters (`@tanstack/ai-openai`'s and `@tanstack/ai-gemini`'s), for `embed()`. It runs the official `@mediapipe/tasks-text` 1.2.2 npm package, a dependency, unmodified and through its public API, in a Web Worker.
  - `mediaPipeEmbedding(model?, config?)` and `MediaPipeEmbeddingAdapter`; the model defaults to `"universal-sentence-encoder"`, Universal Sentence Encoder from Google's storage (6.1 MB, 100 dimensions). Text inputs only, one vector per item; `dimensions` other than the model's throws.
  - Load options (`MediaPipeEmbeddingConfig`): `delegate`, `modelAssetPath`, `wasmPath` (relative paths are relative to the page), and `cacheWasm: false` to load MediaPipe's WebAssembly from `wasmPath` without `blob:` URLs, for a strict Content Security Policy. Adapters with equivalent options share one worker; a load with other options waits for the requests on the previous worker. Per-call options (`MediaPipeEmbeddingProviderOptions`, as `modelOptions`): `l2Normalize` and `quantize`, set on the one embedder through MediaPipe's `setOptions()`; `quantize` normalizes too unless `l2Normalize: false`.
  - Runtime methods on the adapter, as in the other packages: `availability()` (the Prompt API's `Availability` values: `"unavailable"` where MediaPipe can't run the model, `"downloading"` while this page downloads its file, `"available"` when it's loaded or its files are in Cache Storage, else `"downloadable"`; it reads Cache Storage only), `create({ onDownloadProgress?, signal }?)` (the model file's download, 0 to 1, then 1 once ready; its `signal` stops that caller's wait at once, an `AbortError`, and ends the worker when no other caller waits) and `destroy()`; `onDownloadProgress` in the config reports a download the first `embed()` starts.
  - MediaPipe's WebAssembly loads from jsDelivr at the installed version, and the model and WebAssembly are kept in Cache Storage once MediaPipe has loaded them, so later loads work offline; a load from the cache that fails is retried once from the network. Both load on cross-origin isolated pages.
  - `@tanstack-ai-browser/mediapipe/model-meta`: `MEDIAPIPE_EMBEDDING_MODELS`, `MEDIAPIPE_MODEL_META` and their types.
