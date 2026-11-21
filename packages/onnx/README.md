# @tanstack-ai-browser/onnx

A [TanStack AI](https://tanstack.com/ai) image adapter for ONNX models in the browser, on [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web) (1.31.1): WebGPU where the browser has a GPU adapter, else the CPU (WebAssembly). It runs the official package, unmodified, through its public API.

The model today is [Tessera-small](https://huggingface.co/thejagstudio/tessera-small), which draws 16×16 pixel-art sprites from text, in [cfahlgren1's int8 ONNX build](https://huggingface.co/cfahlgren1/tessera-small-onnx) (115 MB).

## Install

```sh
npm install @tanstack-ai-browser/onnx @tanstack/ai
```

## Use

```ts
import { generateImage } from "@tanstack/ai"
import { onnxImage } from "@tanstack-ai-browser/onnx"

const result = await generateImage({
  adapter: onnxImage("cfahlgren1/tessera-small-onnx"),
  prompt: "cat wearing sunglasses",
  numberOfImages: 4,
  threadId
})

for (const image of result.images) {
  const img = document.createElement("img")
  img.src = `data:image/png;base64,${image.b64Json}`
  img.style.imageRendering = "pixelated"
  document.body.append(img)
}
```

Each image is a 16×16 PNG (`b64Json`), with transparency. Scale it up with `image-rendering: pixelated` to keep its pixels sharp.

- `numberOfImages`: 1 to 8 (default 1). They're drawn together in one batch.
- `size`: the model's own, `"16x16"`, or left out.
- `prompt`: text, best as a short phrase. The CLIP text encoder reads 24 tokens. Image parts are refused.
- `modelOptions`: `seed` (the same seed, prompt and settings draw the same images; random if left out), `steps` (default 16; fewer is faster and rougher) and `guidanceScale` (default 3).

## Loading

```ts
const adapter = onnxImage("cfahlgren1/tessera-small-onnx", {
  onDownloadProgress: (progress) => console.log(progress)
})
if ((await adapter.availability()) !== "unavailable") await adapter.create()
```

- `availability()`: `"available"` once the model's files are stored (or it's loaded), `"downloading"` while this adapter downloads them, `"downloadable"` otherwise, and `"unavailable"` without WebAssembly.
- `create()`: downloads the files where they aren't stored, with progress from 0 to 1, and loads the model. `generateImage()` doesn't need it: the first call loads the model too.
- `backend()`: `"webgpu"` or `"wasm"`, once loaded.
- `destroy()` unloads the model and keeps its files. `remove()` deletes the files too.

The files are pinned to a commit and kept in the page's Cache Storage (`tanstack-ai-browser-onnx`). One model is loaded at a time: loading another unloads the first.

### Backends

- **WebGPU** where `navigator.gpu` gives an adapter. If the GPU can't load the model, it falls back to the CPU.
- **WebAssembly** everywhere else. ONNX Runtime's WebAssembly files load from jsDelivr at the installed version. Pass `wasmPaths` to serve them yourself.
- **Not WebGL.** ONNX Runtime's WebGL backend can't run these models: it has no int8 dequantization, among other ops.
- `backend: "webgpu" | "wasm"` forces one.
- `sessionOptions` and `webgpuOptions` pass ONNX Runtime session options and WebGPU backend options (such as `storageBufferCacheMode`) over the adapter's own.
- **Memory on iPhone Safari:** ONNX Runtime 1.31's WebGPU backend held about 1.5 GB there for one Tessera sprite, and four crashed the tab (about 2 GB limit). Its CPU backend held about 620 MB for four. In Chrome its WebGPU buffers were about 160 MB. webgllm's image adapter (`webgllmImage` in `@tanstack-ai-browser/webgllm`) held about 380 MB on WebGPU for one sprite, measured on an iPad Pro.

Constant folding is off when a model loads. Otherwise ONNX Runtime turns every int8 weight into a float32 copy, about four times the memory, which is more than a phone gives a tab. The weights are dequantized as they're used instead.

## License

The package is MIT. **Tessera-small is [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), by Jagrat Patel (TheJagStudio): no commercial use of the model or the images it draws** without a license from its author. The CLIP text encoder is OpenAI's (MIT). The sampler follows Tessera's published one.
