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

It runs the official `@mediapipe/tasks-text` package (1.2.3), unmodified and through its public API, on the page: `FilesetResolver.forTextTasks(wasmPath)`, then `TextEmbedder.createFromOptions` with the model's path, then `embed()` per text. MediaPipe fetches its files itself.

The package is shaped like TanStack's embedding adapters. The root has `mediaPipeEmbedding(model?, config?)`, `MediaPipeEmbeddingAdapter` (with the runtime methods below) and the types `MediaPipeEmbeddingConfig`, `MediaPipeEmbeddingProviderOptions` and `Availability`. It also has the catalog: `MEDIAPIPE_EMBEDDING_MODELS` (one model, `"universal-sentence-encoder"`) and `MEDIAPIPE_MODEL_META` (its file, size and dimensions), with the types `MediaPipeEmbeddingModel`, `MediaPipeEmbeddingModelMeta`, `MediaPipeEmbeddingModelProviderOptionsByName` and `MediaPipeEmbeddingModelInputModalitiesByName`.

## The model

Universal Sentence Encoder as MediaPipe publishes it for its TextEmbedder: a 6.1 MB TFLite file that returns **100 numbers** per text (its one output head, `response_encoding`). Its vectors aren't unit length (about 11), so compare them by cosine similarity, or turn on `l2Normalize` and use the dot product. With five test sentences, paraphrases scored 0.93 ("The cat sat on the mat." and "A cat was sitting on the rug.") and 0.92 (two questions about sourdough), and unrelated pairs 0.67 to 0.79.

## Options

`mediaPipeEmbedding(model = "universal-sentence-encoder", config?)` takes the load options (`MediaPipeEmbeddingConfig`), passed to MediaPipe as they are:

- `delegate`: `"CPU"` (MediaPipe's default) or `"GPU"`, MediaPipe's `baseOptions.delegate`. MediaPipe 1.2.2 runs this model on the CPU either way (TFLite's XNNPACK in WebAssembly): with `"GPU"` it still creates the CPU delegate and returns the same vectors.
- `modelAssetPath`: MediaPipe's `baseOptions.modelAssetPath`, the model's TFLite file, to serve it yourself, or another MediaPipe text embedder model.
- `wasmPath`: the folder MediaPipe's WebAssembly is served from (see below).

Per call, `embed()`'s `modelOptions` (`MediaPipeEmbeddingProviderOptions`) goes to MediaPipe's `TextEmbedder.setOptions()`:

- `l2Normalize`: normalizes each vector to unit length.
- `quantize`: scalar-quantizes each vector to bytes; each number is then an integer from -128 to 127 (the byte read as signed). MediaPipe's quantization assumes unit-length vectors, so use it with `l2Normalize` (without it, most numbers are clipped at ±127).

Both are off unless set. Calls on one adapter run one at a time, so one call's options never apply to another's texts.

`dimensions` isn't configurable: the model returns 100, so `dimensions` set to anything else throws (not checked with a custom `modelAssetPath`). Inputs are text only (strings and text parts; an image part throws), one vector per input item. MediaPipe doesn't count tokens, so the result has no `usage`.

## The runtime

Each adapter creates its own TextEmbedder, on its first `embed()` or `create()`. The adapter has the same three runtime methods as this project's language model adapters, with the Prompt API's values:

- `adapter.availability()` resolves to `"unavailable"` without WebAssembly, `"available"` once the adapter's embedder is created, `"downloading"` while it's being created, else `"downloadable"`. MediaPipe's files may already be in the browser's HTTP cache, but a page can't tell, so before the first load it says `"downloadable"`.
- `adapter.create()` creates the embedder ahead of the first `embed()`. It resolves to the adapter, and rejects if MediaPipe can't load; it's fine to leave unawaited. After a failed load, the next call tries again. MediaPipe reports no download progress, so there's none to hear.
- `adapter.destroy()` closes the embedder (MediaPipe's `close()`), freeing it; the next call creates it again.

## Where the files load from

- The model, from Google's own storage: `https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite` (6,120,274 bytes).
- MediaPipe's WebAssembly (7 MB), from the installed `@mediapipe/tasks-text`'s own folder on jsDelivr: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@1.2.3/wasm`. It has to match MediaPipe's JavaScript, so it's the same version. To host it yourself, serve `node_modules/@mediapipe/tasks-text/wasm` and pass its URL as `wasmPath`.

MediaPipe fetches them itself, so the browser's HTTP cache keeps them between loads. Both load on cross-origin isolated pages (`Cross-Origin-Embedder-Policy: require-corp`): Google's storage sends CORS (`Access-Control-Allow-Origin: *`), and jsDelivr sends CORS and `Cross-Origin-Resource-Policy: cross-origin`.

Embedding runs on the page's main thread, about 50 ms per short sentence once warm (measured in Chromium on an M3 Ultra).

**Status:** early (0.0.x); the API may change. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).
