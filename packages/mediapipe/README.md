# @tanstack-ai-browser/mediapipe

A [TanStack AI](https://tanstack.com/ai) embedding adapter for Google's [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/text/text_embedder/web_js) TextEmbedder, which runs Universal Sentence Encoder in the browser. Hand it to `embed()` like TanStack's own embedding adapters (`openaiEmbedding`, `geminiEmbedding`): the text never leaves the device.

```sh
npm install @tanstack-ai-browser/mediapipe @tanstack/ai
```

```ts
import { embed } from "@tanstack/ai"
import { mediaPipeEmbedding } from "@tanstack-ai-browser/mediapipe"

const adapter = mediaPipeEmbedding()
if ((await adapter.availability()) !== "unavailable") {
  const result = await embed({
    adapter,
    input: ["The cat sat on the mat.", "A cat was sitting on the rug."],
    modelOptions: { l2Normalize: true }
  })
  result.embeddings[0].vector // 100 numbers
}
```

It runs the official `@mediapipe/tasks-text` package (1.2.2), unmodified and through its public API, in a Web Worker of its own, so embedding doesn't hold up the page.

The package is shaped like TanStack's embedding adapters. The root has `mediaPipeEmbedding(model?, config?)`, `MediaPipeEmbeddingAdapter` (with the runtime methods below) and the types `MediaPipeEmbeddingConfig`, `MediaPipeEmbeddingProviderOptions`, `Availability` and `DownloadProgressCallback`. `@tanstack-ai-browser/mediapipe/model-meta` has `MEDIAPIPE_EMBEDDING_MODELS` (one model, `"universal-sentence-encoder"`) and `MEDIAPIPE_MODEL_META` (its file, size and dimensions), with the types `MediaPipeEmbeddingModel`, `MediaPipeEmbeddingModelMeta`, `MediaPipeEmbeddingModelProviderOptionsByName` and `MediaPipeEmbeddingModelInputModalitiesByName`.

## The model

Universal Sentence Encoder as MediaPipe publishes it for its TextEmbedder: a 6.1 MB TFLite file that returns **100 numbers** per text (its one output head, `response_encoding`). Its vectors aren't unit length (about 11), so compare them by cosine similarity, or turn on `l2Normalize` and use the dot product. With five test sentences, paraphrases scored 0.93 ("The cat sat on the mat." and "A cat was sitting on the rug.") and 0.92 (two questions about sourdough), and unrelated pairs 0.67 to 0.79.

## Options

`mediaPipeEmbedding(model = "universal-sentence-encoder", config?)` takes the load options (`MediaPipeEmbeddingConfig`):

- `delegate`: `"CPU"` (MediaPipe's default) or `"GPU"`, MediaPipe's `baseOptions.delegate`. MediaPipe 1.2.2 runs this model on the CPU either way (TFLite's XNNPACK in WebAssembly): with `"GPU"` it still creates the CPU delegate and returns the same vectors, in the worker and on the page alike.
- `modelAssetPath`: the model's TFLite file, to serve it yourself, or another MediaPipe text embedder model.
- `wasmPath`: the folder MediaPipe's WebAssembly is served from (see below).
- `cacheWasm`: `false` to have MediaPipe load its WebAssembly straight from `wasmPath` instead of from Cache Storage through `blob:` URLs, for a strict Content Security Policy (see below). True by default.
- `onDownloadProgress`: the model file's download, 0 to 1, when a call (the first `embed()`) starts it; then 1 once the embedder is ready.

Relative paths in `modelAssetPath` and `wasmPath` are relative to the page (its `document.baseURI`), not to the worker's script. Load options are compared by their effective values (absolute URLs, the CPU for an unset `delegate`), so adapters whose options come to the same thing share one worker.

Per call, `embed()`'s `modelOptions` (`MediaPipeEmbeddingProviderOptions`) maps to MediaPipe's embedder options:

- `l2Normalize`: normalizes each vector to unit length.
- `quantize`: scalar-quantizes each vector to bytes; each number is then an integer from -128 to 127. MediaPipe's quantization assumes unit-length vectors, so `l2Normalize` is on with it unless you set it to `false` (without it, most numbers would be clipped at ±127).

MediaPipe takes these at creation and through `TextEmbedder.setOptions()`, so the one embedder is kept and set again when a call's options differ from the last call's (it restarts MediaPipe's graph, a few milliseconds); calls run one at a time, so options never change during a batch.

`dimensions` isn't configurable: the model returns 100, so `dimensions` set to anything else throws. With a custom `modelAssetPath`, it's checked against what the model returns. Inputs are text only (strings and text parts; an image part throws), one vector per input item. MediaPipe doesn't count tokens, so the result has no `usage`.

## The runtime

The adapter has the same three runtime methods as this project's language model adapters, with the Prompt API's values:

- `adapter.availability()` resolves to `"unavailable"` where MediaPipe can't run (it needs WebAssembly with SIMD, which MediaPipe has no build without, and Web Workers; not on a server) or the model isn't listed, `"downloading"` while this page downloads the model's file, `"available"` when the file (and, with `cacheWasm`, MediaPipe's WebAssembly) is in Cache Storage, else `"downloadable"`.
- `adapter.createSessionWithProgress(onDownloadProgress?)` downloads (the first time) and loads the embedder ahead of the first `embed()`, replacing any other; `embed()` loads it otherwise. `onDownloadProgress` hears the model file's download, 0 to 1, then 1 once it's ready (at once if it already is). It resolves to the adapter, and rejects on failure; it's fine to leave unawaited. Loading another model or the same with other load options replaces the worker; requests already waiting on the previous one finish on it first, and it ends once they're done.
- `adapter.destroySession()` ends the worker at once, freeing the embedder (requests waiting on it fail), if it's this model's. Adapters with the same model and load options share one embedder, so this frees it for all of them. The files stay in Cache Storage.

The model is 6.1 MB and MediaPipe's WebAssembly 7 MB, so there's no memory budget to set here, unlike the language model packages.

## Where the files load from

- The model, from Google's own storage: `https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite` (6,120,274 bytes).
- MediaPipe's WebAssembly (`text_wasm_module_internal.js` and `.wasm`, its ES module build, since the worker is a module worker), from the installed `@mediapipe/tasks-text`'s own folder on jsDelivr: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@1.2.2/wasm`. It has to match MediaPipe's JavaScript, so it's the same version. To host it yourself, serve `node_modules/@mediapipe/tasks-text/wasm` and pass its URL as `wasmPath`.

Both load on cross-origin isolated pages (`Cross-Origin-Embedder-Policy: require-corp`): Google's storage sends CORS (`Access-Control-Allow-Origin: *`) and the worker fetches with CORS, and jsDelivr sends CORS and `Cross-Origin-Resource-Policy: cross-origin`.

The worker downloads the three files once and keeps them in Cache Storage (`tanstack-ai-browser-mediapipe`), then hands them to MediaPipe from memory (the model as `modelAssetBuffer`, the WebAssembly as blob URLs in its fileset), so later loads work offline: about 0.25 s from the cache, against 0.6 to 1.6 s downloading. Files are kept only once MediaPipe has loaded them, so a bad response (an error or captive-portal page with a 200) is never kept; if a load from the cache fails, its files are deleted from the cache and the load is tried once more from the network. Files of other MediaPipe versions on jsDelivr are removed from the cache. Without Cache Storage (an insecure context), they're downloaded each load.

## Content Security Policy

The worker is a module worker from the package's `worker.js`, so `worker-src` (or `script-src`) has to allow the site's own scripts, and MediaPipe compiles WebAssembly, which needs `'wasm-unsafe-eval'` in `script-src`. A worker takes its policy from its own script's response headers.

- By default MediaPipe's loader and WebAssembly come from Cache Storage as `blob:` URLs, so the worker's policy needs `blob:` in `script-src` and `connect-src`, and the hosts of the files it downloads in `connect-src` (`storage.googleapis.com` and `cdn.jsdelivr.net` by default).
- Under a policy without `blob:`, such as `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`, serve the model and `node_modules/@mediapipe/tasks-text/wasm` from your site and pass `cacheWasm: false`:

```ts
mediaPipeEmbedding("universal-sentence-encoder", {
  modelAssetPath: "/models/universal_sentence_encoder.tflite",
  wasmPath: "/mediapipe/wasm",
  cacheWasm: false
})
```

MediaPipe then imports its loader and fetches its WebAssembly from `wasmPath` itself (the browser's HTTP cache keeps them); the model is still kept in Cache Storage.

Measured in Chromium on an M3 Ultra, in the worker: about 50 ms per short sentence once warm (5 sentences in 225 to 290 ms; the first batch 350 to 400 ms).

**Status:** early (0.0.x); the API may change. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).
