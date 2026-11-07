/**
 * Runs a local model with Transformers.js on WebGPU, off the main thread so
 * the page stays smooth while it loads and generates. One model at a time:
 * loading another frees the previous one. Transformers.js is the official
 * `@huggingface/transformers` package, used as published: it downloads and
 * caches the model's files, and runs them on its own ONNX Runtime.
 *
 * Without WebGPU (Firefox on Android, say), the same models run on the CPU
 * through ONNX Runtime's WebAssembly backend, from their q4 weights (float32
 * activations, which the CPU kernels want): slower, but the same features,
 * prompt caching in memory and on disk included.
 */
import { createConstraint } from "./constraint/index.js"
import { GenerationControl, thinkingControlTokens } from "./generation-control.js"
import { createSampler } from "./sampling.js"
import type {
  ChatTurn,
  RunTimings,
  WorkerSampling,
  ToolSpec,
  WeightsDtype,
  WorkerRequest,
  WorkerResponse
} from "./protocol.js"
import {
  MIN_PROMPT_STEP,
  nextPromptStep,
  promptStepEnd
} from "./prompt-steps.js"
import { checkpointsToDrop } from "./checkpoints.js"
import { reusablePrefixLength, systemPrefixTokens } from "./prompt-prefix.js"

/**
 * Diagnostics (memory and cache logs, error stacks) when the page started
 * the worker with debug on: it's named "…:debug" then, which the worker can
 * read before any message arrives.
 */
const DEBUG =
  (globalThis as { name?: string }).name?.endsWith(":debug") ?? false

type TransformersModule = typeof import("@huggingface/transformers")

/**
 * Transformers.js, imported when the first model loads (so a page that
 * never loads one never downloads it), and set up once.
 */
let transformers: Promise<TransformersModule> | null = null

function importTransformers(device: Device) {
  transformers ??= import("@huggingface/transformers").then((tf) => {
    tf.env.fetch = fetchWithoutReferrer
    return tf
  })
  return transformers
}

/* Minimal shapes of the Transformers.js objects used here. */
type Tensor = InstanceType<TransformersModule["Tensor"]>
/**
 * The model's memory of the text so far: attention keys/values
 * ("past_key_values.*") and conv states ("past_conv.*"), by input name.
 */
type Cache = InstanceType<TransformersModule["DynamicCache"]>
type Tokenizer = {
  chat_template?: string | null
  eos_token_id?: number
  all_special_ids?: number[]
  decode: (
    ids: Array<bigint>,
    options: { skip_special_tokens: boolean }
  ) => string
  apply_chat_template: (
    messages: Array<ChatTurn>,
    options: Record<string, unknown>
  ) => string
  (text: string, options: Record<string, unknown>): { input_ids: Tensor }
}
type Model = {
  generation_config?: { eos_token_id?: number | Array<number>; max_new_tokens?: number }
  config?: { eos_token_id?: number | Array<number> }
  generate: (options: Record<string, unknown>) => Promise<unknown>
  forward: (inputs: Record<string, unknown>) => Promise<Record<string, Tensor>>
  dispose: () => Promise<unknown>
}
type StoppingCriteria = { interrupt: () => void; interrupted: boolean }
type ModelClass = {
  from_pretrained: (
    id: string,
    options: Record<string, unknown>
  ) => Promise<unknown>
}
/** The parts of a model's config.json read here. */
type ModelConfig = {
  architectures?: Array<string>
  max_position_embeddings?: number
  text_config?: { max_position_embeddings?: number }
}

/*
 * Hugging Face answers requests referred from *.workers.dev with a 404 and no
 * CORS headers, which the browser reports as "Failed to fetch". The page's
 * no-referrer meta tag doesn't reach workers, so every request from here
 * leaves the referrer out itself (Transformers.js's `env.fetch`).
 */
const fetchWithoutReferrer = (input: string | URL, init?: RequestInit) =>
  fetch(input, { ...init, referrerPolicy: "no-referrer" })

/** Where a model runs: the GPU, or the CPU through WebAssembly. */
type Device = "webgpu" | "wasm"

type Runtime = {
  tf: TransformersModule
  tokenizer: Tokenizer
  model: Model
  /** The model's end-of-turn tokens, taken out of the text it streams. */
  endTokens: RegExp
  device: Device
  /** The weights loaded: q4 on the CPU, whatever was asked for on the GPU. */
  dtype: WeightsDtype
  /** The model's config, for its context window. */
  config: ModelConfig
}

/**
 * Threads for a model on the CPU: half the cores the browser reports, as
 * wllama does (ONNX Runtime's own default is half, up to 4), which leaves
 * cores for the page and keeps a phone's slowest cores out of the work. On
 * an M3 Ultra, 4 threads wrote 3.0 tokens/s, 8 wrote 5.5 and 16 wrote 8.8.
 * Several threads need a cross-origin isolated page; without one it's a
 * single thread whatever this says.
 */
const cpuThreads = () =>
  Math.max(1, Math.floor((navigator.hardwareConcurrency || 1) / 2))

/**
 * WebGPU if this browser has it and can get a GPU adapter, else the CPU.
 * Some browsers have `navigator.gpu` but no adapter (a blocklisted GPU, or
 * WebGPU turned off).
 */
async function pickDevice(): Promise<Device> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown> }
  }
  if (!nav.gpu) return "wasm"
  try {
    return (await nav.gpu.requestAdapter()) ? "webgpu" : "wasm"
  } catch {
    return "wasm"
  }
}

const ctx = globalThis as unknown as {
  postMessage: (message: WorkerResponse) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

/*
 * GPU state, for the prompt cache's copies and for error messages: ONNX
 * Runtime's GPU device (from its public `env.webgpu.device`), why it was
 * lost and any GPU error it reported, if those happen.
 */
const gpu = {
  /** ONNX Runtime's GPU device, once a model has loaded on it. */
  device: null as GPUDevice | null,
  lost: null as string | null,
  error: null as string | null,
  promptTokens: 0
}

/** Devices already watched for loss and errors. */
const watched = new WeakSet<GPUDevice>()

/** Takes ONNX Runtime's GPU device once a model has loaded on it. */
async function watchDevice(tf: TransformersModule) {
  const device = await tf.env.backends.onnx.webgpu?.device
  if (!device) return
  gpu.device = device
  if (watched.has(device)) return
  watched.add(device)
  gpu.lost = null
  gpu.error = null
  void device.lost.then((info) => {
    gpu.lost = `${info.reason}${info.message ? `: ${info.message}` : ""}`
    for (const notify of lostWaiters) notify()
  })
  device.addEventListener("uncapturederror", (event) => {
    gpu.error = (event as GPUUncapturedErrorEvent).error.message
  })
}

/** Called when the GPU device is lost. */
const lostWaiters = new Set<() => void>()

/**
 * Runs `work`, failing as soon as the GPU device is lost. When Safari's GPU
 * process crashes, ONNX Runtime can wait forever on a GPU that is gone, and
 * the reply would sit at "Thinking..." with no error.
 */
async function unlessGpuLost<T>(work: Promise<T>): Promise<T> {
  let notify = () => undefined as void
  const lost = new Promise<never>((_, reject) => {
    notify = () =>
      reject(
        new Error(
          "The GPU stopped while the model was running (Safari reset it). Send your message again to reload the model."
        )
      )
  })
  lostWaiters.add(notify)
  try {
    return await Promise.race([work, lost])
  } finally {
    lostWaiters.delete(notify)
  }
}

/** What the GPU looked like when something failed, for the error message. */
function gpuReport() {
  return [
    `prompt: ${gpu.promptTokens} tokens`,
    gpu.lost && `device lost: ${gpu.lost}`,
    gpu.error && `GPU error: ${gpu.error}`
  ]
    .filter(Boolean)
    .join("; ")
}

/** OPFS sync access handles (worker-only, not in the DOM typings). */
type SyncAccessHandle = {
  read: (buffer: Uint8Array, options: { at: number }) => number
  write: (buffer: Uint8Array, options: { at: number }) => number
  truncate: (size: number) => void
  getSize: () => number
  flush: () => void
  close: () => void
}
const openSync = (file: FileSystemFileHandle) =>
  (
    file as unknown as {
      createSyncAccessHandle: () => Promise<SyncAccessHandle>
    }
  ).createSyncAccessHandle()

/**
 * A model id is a Hugging Face repo, optionally pinned to a commit:
 * "owner/repo@revision". Pinning makes browsers fetch that version's files
 * instead of reusing cached ones from an older version.
 */
function parseModelId(modelId: string) {
  const [repo, revision = "main"] = modelId.split("@")
  return { repo, revision }
}

/**
 * A text model's ONNX files: not a multimodal build's vision or audio
 * encoder, which aren't loaded (see modelClass).
 */
const isTextModelFile = (path: string) =>
  path.startsWith("onnx/") && !/\/(?:vision|audio)_encoder/.test(path)

/**
 * The model's ONNX files for this dtype and device, with their sizes and
 * whether Transformers.js has them cached, from its ModelRegistry.
 */
async function modelFiles(
  tf: TransformersModule,
  repo: string,
  revision: string,
  config: ModelConfig,
  dtype: WeightsDtype,
  device: Device
) {
  const paths = (
    await tf.ModelRegistry.get_model_files(repo, {
      config: config as never,
      dtype,
      device
    })
  ).filter(isTextModelFile)
  const metadata = await Promise.all(
    paths.map((path) =>
      tf.ModelRegistry.get_file_metadata(repo, path, { revision })
    )
  )
  return paths.map((path, i) => ({
    path,
    exists: metadata[i].exists,
    size: metadata[i].size ?? 0,
    cached: metadata[i].fromCache === true
  }))
}

/**
 * Removes the weights earlier versions of this package downloaded to the
 * Origin Private File System themselves (`*.onnx_data*` with their
 * `.done`/`.etag` markers and `weights.*.json` listings): Transformers.js
 * keeps the model's files in its own cache now. Once per worker.
 */
let removedLegacyWeights = false

async function removeLegacyWeights() {
  if (removedLegacyWeights) return
  removedLegacyWeights = true
  try {
    const dir = await navigator.storage.getDirectory()
    const legacy: Array<string> = []
    for await (const [name, entry] of (
      dir as unknown as {
        entries: () => AsyncIterable<[string, FileSystemHandle]>
      }
    ).entries()) {
      if (entry.kind !== "file") continue
      if (
        /\.onnx_data(?:_\d+)?(?:\.done|\.etag)?$/.test(name) ||
        /\.weights\.q4(?:f16)?\.json$/.test(name) ||
        name.startsWith("lfm3-1.7b-")
      ) {
        legacy.push(name)
      }
    }
    for (const name of legacy) await dir.removeEntry(name)
  } catch {
    // Nothing to clean up.
  }
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The model's end-of-turn tokens as text, to take out of what it streams:
 * its end-of-sequence tokens (`<|im_end|>` for LFM, `<turn|>` for Gemma 4),
 * and ChatML's.
 */
function endTokens(tokenizer: Tokenizer, model: Model) {
  const ids = [
    model.generation_config?.eos_token_id,
    model.config?.eos_token_id
  ].flatMap((id) => (id === undefined ? [] : Array.isArray(id) ? id : [id]))
  const texts = new Set(["<|im_end|>", "<|endoftext|>", "<|im_start|>"])
  for (const id of ids) {
    const text = tokenizer.decode([BigInt(id)], { skip_special_tokens: false })
    if (text.trim()) texts.add(text)
  }
  return new RegExp([...texts].map(escapeRegExp).join("|"), "g")
}

/**
 * The class to load the model with. This package runs text only, so a
 * multimodal build (`Qwen3_5ForConditionalGeneration`, say) loads with its
 * family's causal-LM class, which Transformers.js gives just the embedding
 * and decoder, not the vision and audio encoders. Otherwise its own class
 * from the config.
 */
async function modelClass(
  tf: TransformersModule,
  repo: string,
  revision: string
) {
  const config = (await tf.AutoConfig.from_pretrained(repo, {
    revision
  })) as unknown as ModelConfig
  const classes = tf as unknown as Record<string, ModelClass | undefined>
  const arch = config.architectures?.[0]
  const textModel = arch?.endsWith("ForConditionalGeneration")
    ? classes[arch.replace(/ForConditionalGeneration$/, "ForCausalLM")]
    : undefined
  const own = arch ? classes[arch] : undefined
  return {
    Model: textModel ?? own ?? (tf.AutoModelForCausalLM as ModelClass),
    config
  }
}

/** Resolves when the page answers a "claim" (see claimMemory). */
let claimed: (() => void) | null = null

/** Asks the page to make room for the model, and waits until it has. */
function claimMemory(modelId: string, bytes: number) {
  return new Promise<void>((resolve) => {
    claimed = resolve
    ctx.postMessage({ type: "claim", modelId, bytes: Math.round(bytes) })
  })
}

let current: {
  modelId: string
  dtype: WeightsDtype
  /** Tokens a chat may hold by default, as the load asked. */
  contextLength: number | undefined
  runtime: Promise<Runtime>
} | null = null

/** Tokens a chat may hold when neither the caller nor the config says. */
const FALLBACK_CONTEXT = 8192

/**
 * Tokens a chat may hold: what was asked for, at most the model's own
 * context window (its config's max_position_embeddings), which is also the
 * default.
 */
function contextFor(config: ModelConfig, requested: number | undefined) {
  const own =
    config.max_position_embeddings ??
    config.text_config?.max_position_embeddings
  const wanted = requested ?? own ?? FALLBACK_CONTEXT
  return own ? Math.min(wanted, own) : wanted
}

async function loadRuntime(
  modelId: string,
  requested: WeightsDtype
): Promise<Runtime> {
  const device = await pickDevice()
  // The CPU kernels want float32 activations: q4 weights.
  const dtype: WeightsDtype = device === "wasm" ? "q4" : requested
  const tf = await importTransformers(device)
  if (device === "wasm" && tf.env.backends.onnx.wasm) {
    tf.env.backends.onnx.wasm.numThreads = cpuThreads()
  }
  const { repo, revision } = parseModelId(modelId)
  const { Model, config } = await modelClass(tf, repo, revision)
  const files = await modelFiles(tf, repo, revision, config, dtype, device)
  if (files.length === 0 || files.some((f) => !f.exists)) {
    if (device === "webgpu") throw new Error(`${repo} has no ${dtype} ONNX weights.`)
    throw new Error(
      "This model needs WebGPU, which this browser doesn't have, and it has no weights for running on the CPU. Pick another model."
    )
  }
  const cached = files.every((f) => f.cached)
  const total = files.reduce((sum, f) => sum + f.size, 0)
  // Room for it first: the page unloads other runtimes' models past the
  // memory budget. On the GPU it takes about its weights (plus the cache);
  // on the CPU, ONNX Runtime's working buffers too.
  await claimMemory(modelId, total * (device === "wasm" ? 1.3 : 1.15))
  ctx.postMessage({ type: "progress", modelId, progress: 0, cached })
  // Bytes downloaded per file, from Transformers.js's progress reports;
  // whole percents only.
  const loaded = new Map<string, number>()
  let lastPercent = -1
  const onProgress = (info: { status: string; file?: string; loaded?: number }) => {
    if (cached || info.status !== "progress" || !info.file || !total) return
    loaded.set(info.file, info.loaded ?? 0)
    const bytes = [...loaded.values()].reduce((sum, b) => sum + b, 0)
    const percent = Math.min(100, Math.floor((bytes / total) * 100))
    if (percent === lastPercent) return
    lastPercent = percent
    ctx.postMessage({
      type: "progress",
      modelId,
      progress: percent / 100,
      cached: false,
      loadedBytes: Math.min(bytes, total),
      totalBytes: total
    })
  }
  const tokenizer = (await tf.AutoTokenizer.from_pretrained(repo, {
    revision
  })) as unknown as Tokenizer
  const model = (await Model.from_pretrained(repo, {
    revision,
    config,
    dtype,
    device,
    progress_callback: onProgress,
    session_options: {
      executionProviders: [device],
      // No constant folding: LFM exports read the tied embedding's 4-bit
      // weights into the output layer through a Reshape, and folding it
      // copied the whole table into ONNX Runtime's WebAssembly memory
      // (which never shrinks) and, on the GPU, uploaded a second copy.
      // LFM3: 408 MB of WebAssembly memory and 131 MB of GPU memory;
      // LFM2-1.2B-Tool: 819 MB. Without it: 17 MB, the same replies and
      // speed, and a load from disk in 1.5 s instead of 21 on a Mac.
      extra: {
        "optimization.disable_specified_optimizers": "ConstantFolding"
      }
    }
  })) as Model
  if (device === "webgpu") await watchDevice(tf)
  return {
    tf,
    tokenizer,
    model,
    endTokens: endTokens(tokenizer, model),
    device,
    dtype,
    config
  }
}

/**
 * Loads `modelId` for chats of up to `contextLength` tokens by default (the
 * model's own context window when left out), freeing whichever model was
 * loaded before. The same model with another context length isn't loaded
 * again: the length is the runs' default.
 */
function load(
  modelId: string,
  dtype: WeightsDtype,
  contextLength: number | undefined
) {
  if (current?.modelId === modelId && current.dtype === dtype) {
    current.contextLength = contextLength
    const { runtime } = current
    runtime.then(
      () => ctx.postMessage({ type: "ready", modelId }),
      () => undefined
    )
    return runtime
  }
  const previous = current?.runtime
  const runtime = (async () => {
    // The kept caches belong to the previous model.
    await discardSaved()
    await previous?.then((r) => r.model.dispose()).catch(() => undefined)
    void removeLegacyWeights()
    return loadRuntime(modelId, dtype)
  })()
  current = { modelId, dtype, contextLength, runtime }
  runtime.then(
    () => {
      ctx.postMessage({ type: "ready", modelId })
    },
    (error: unknown) => {
      if (current?.runtime === runtime) current = null
      ctx.postMessage({
        type: "load-error",
        modelId,
        message: errorMessage(error)
      })
    }
  )
  return runtime
}

const running = new Map<string, StoppingCriteria>()
const requests = new Map<string, AbortController>()

/** A chat past the context limit: shown as is, without GPU diagnostics. */
class ContextLimitError extends Error {}

/** Tokens per ms of the last prompt step, carried over to the next prompt. */
let promptRate: number | null = null

/** Transformers.js's names for a model output's place in the cache. */
const cacheName = (output: string) =>
  output
    .replace("present_conv", "past_conv")
    .replace("present_ssm", "past_ssm")
    .replace("present_recurrent", "past_recurrent")
    .replace("present", "past_key_values")

/** A cache's tensors by name (its methods live on its prototype). */
const cacheTensors = (cache: Cache) =>
  Object.entries(cache) as Array<[string, Tensor]>

/** Attention keys/values, which grow a row per token and can be cut short. */
const isKeysValues = (name: string) => name.startsWith("past_key_values.")

/** GPUBufferUsage.STORAGE | COPY_SRC | COPY_DST. */
const CACHE_BUFFER_USAGE = 0x80 | 0x4 | 0x8

/** Typed arrays, as ONNX Runtime's CPU tensors hold their data. */
type TensorData = Float32Array | Uint16Array

/** An array of the same kind as `data`, `length` elements long. */
const sameKind = (data: TensorData, length: number): TensorData =>
  data instanceof Float32Array
    ? new Float32Array(length)
    : new Uint16Array(length)

/**
 * A CPU tensor's data, copied: whole, or with `length`, keys/values shaped
 * [batch, heads, tokens, head size] cut to each head's first `length`
 * tokens. The CPU twin of the GPU copies below.
 */
function copyCpuData(tensor: Tensor, length?: number) {
  const data = tensor.data as TensorData
  const dims = [...tensor.dims]
  if (length === undefined) return { data: data.slice(), dims }
  const [batch, heads, tokens, size] = dims
  const copy = sameKind(data, batch * heads * length * size)
  for (let i = 0; i < batch * heads; i++) {
    copy.set(
      data.subarray(i * tokens * size, i * tokens * size + length * size),
      i * length * size
    )
  }
  return { data: copy, dims: [batch, heads, length, size] }
}

/**
 * A copy of a cache tensor, on the GPU or the CPU, where it is. With
 * `length`, keys/values shaped [batch, heads, tokens, head size] keep each
 * head's first `length` tokens.
 */
function copyCacheTensor(
  tf: TransformersModule,
  tensor: Tensor,
  length?: number
): Tensor {
  if (tensor.location !== "gpu-buffer") {
    const { data, dims } = copyCpuData(tensor, length)
    return new tf.Tensor(tensor.ort_tensor.type, data, dims)
  }
  const source = tensor.ort_tensor.gpuBuffer
  const device = gpu.device
  if (!source || !device) throw new Error("The model's cache isn't on the GPU.")
  const dims = [...tensor.dims]
  const bytes = tensor.ort_tensor.type === "float16" ? 2 : 4
  let target = dims
  let pieces = 1
  let from = dims.reduce((a, b) => a * b, 1) * bytes
  let to = from
  if (length !== undefined) {
    const [batch, heads, tokens, size] = dims
    target = [batch, heads, length, size]
    pieces = batch * heads
    from = tokens * size * bytes
    to = length * size * bytes
  }
  const buffer = device.createBuffer({
    size: pieces * to,
    usage: CACHE_BUFFER_USAGE
  })
  const encoder = device.createCommandEncoder()
  for (let i = 0; i < pieces; i++) {
    encoder.copyBufferToBuffer(source, i * from, buffer, i * to, to)
  }
  device.queue.submit([encoder.finish()])
  return gpuTensor(tf, buffer, tensor.ort_tensor.type, target)
}

/**
 * A tensor over a GPU buffer, which it destroys when disposed. Transformers.js
 * hands anything that isn't an ONNX Runtime tensor to ONNX Runtime's Tensor
 * constructor, which takes a GPU buffer's location, type, dims and dispose
 * as one object (its typings list only `(type, data, dims)` and an ONNX
 * Runtime tensor, hence the cast). Not Tensor.fromGpuBuffer: Transformers.js
 * imports `onnxruntime-common`'s Tensor class beside the one bundled in
 * `onnxruntime-web`, and a tensor of the other class isn't recognised.
 */
const gpuTensor = (
  tf: TransformersModule,
  gpuBuffer: GPUBuffer,
  type: string,
  dims: Array<number>
) =>
  new (tf.Tensor as unknown as new (fields: {
    location: "gpu-buffer"
    gpuBuffer: GPUBuffer
    type: string
    dims: Array<number>
    dispose: () => void
  }) => Tensor)({
    location: "gpu-buffer",
    gpuBuffer,
    type,
    dims,
    dispose: () => gpuBuffer.destroy()
  })

/*
 * Prompt caching. The model's cache from each run is kept, so the next run
 * reads only what's new instead of the whole chat again: after a tool call,
 * the next prompt is the last one plus the call and its result; a follow-up
 * message repeats the chat up to the last reply. Keys/values can be cut back
 * to any length, but conv states hold only the latest position, so they're
 * also saved at points to go back to (checkpoints): where each prompt ends,
 * and where a prompt stopped matching the cache (in a new chat, usually the
 * end of the system prompt and tools, which the next chat repeats).
 *
 * Several caches are kept, and each run takes the one its prompt matches
 * best, so agents that take turns on the model keep one each: an agent and
 * the sub-agents it runs have different system prompts and tools, and with
 * one cache each would wipe out the other's.
 * ~22 KB per token of GPU memory, plus the checkpoints (0.3 MB each for
 * LFM3, 10.3 MB for Qwen3.5; CHECKPOINT_BYTES in all at most).
 */
type Checkpoint = { length: number; states: Record<string, Tensor> }
type SavedCache = {
  modelId: string
  /** The tokens the cache has read, in order. */
  ids: Array<number>
  cache: Cache
  /** Ascending by length. */
  checkpoints: Array<Checkpoint>
}
/** Most recently used first. */
let savedCaches: Array<SavedCache> = []
/** Caches kept between runs, at most. */
const MAX_SAVED = 6
/**
 * Tokens all kept caches may hold together (~180 MB). Past that, the least
 * recently used are first cut back to their first checkpoint (usually the
 * end of their system prompt and tools, all a finished sub-agent run leaves
 * for the next), then dropped. The latest is always kept whole.
 */
const SAVED_TOKENS = 8192
/** Checkpoints kept per cache: the oldest (shortest) and the latest ones. */
const MAX_CHECKPOINTS = 6
/**
 * Bytes all checkpoints may take together, the run's own included (see
 * checkpoints.ts): LFM3's never come near it (6 caches x 6 x 0.3 MB);
 * Qwen3.5's would reach ~370 MB without it.
 */
const CHECKPOINT_BYTES = 64 * 1024 * 1024

const disposeCheckpoint = (checkpoint: Checkpoint) => {
  for (const tensor of Object.values(checkpoint.states)) tensor.dispose()
}

/** A tensor's size in bytes. */
const tensorBytes = (tensor: Tensor) =>
  tensor.dims.reduce((a, b) => a * b, 1) *
  (tensor.ort_tensor.type === "float16" ? 2 : 4)

const checkpointBytes = (checkpoint: Checkpoint) =>
  Object.values(checkpoint.states).reduce((sum, t) => sum + tensorBytes(t), 0)

/**
 * Drops checkpoints past MAX_CHECKPOINTS per cache and CHECKPOINT_BYTES in
 * all; `lists` is each cache's checkpoints, most recently used first.
 */
function fitCheckpoints(lists: Array<Array<Checkpoint>>) {
  const drops = checkpointsToDrop(
    lists.map((list) => list.map(checkpointBytes)),
    MAX_CHECKPOINTS,
    CHECKPOINT_BYTES
  )
  for (const [i, list] of lists.entries()) {
    if (drops[i].size === 0) continue
    const kept = list.filter((c, k) => {
      if (drops[i].has(k)) disposeCheckpoint(c)
      return !drops[i].has(k)
    })
    list.splice(0, list.length, ...kept)
  }
}

const disposeSaved = async (entry: SavedCache) => {
  entry.checkpoints.forEach(disposeCheckpoint)
  await entry.cache.dispose().catch(() => undefined)
}

/** Frees every kept cache. */
async function discardSaved() {
  const all = savedCaches
  savedCaches = []
  await Promise.all(all.map(disposeSaved))
}

/** Cuts a kept cache back to its first checkpoint; false if it can't. */
function trimSaved(tf: TransformersModule, entry: SavedCache) {
  const first = entry.checkpoints.at(0)
  if (!first || first.length >= entry.ids.length) return false
  try {
    const entries: Record<string, Tensor> = {}
    for (const [name, tensor] of cacheTensors(entry.cache)) {
      entries[name] = isKeysValues(name)
        ? copyCacheTensor(tf, tensor, first.length)
        : copyCacheTensor(tf, first.states[name])
    }
    entry.cache.update(entries)
  } catch {
    return false
  }
  entry.checkpoints.slice(1).forEach(disposeCheckpoint)
  entry.checkpoints = [first]
  entry.ids = entry.ids.slice(0, first.length)
  return true
}

/** Keeps a run's cache, trimming or dropping others past the limits. */
function keepSaved(tf: TransformersModule, entry: SavedCache) {
  savedCaches.unshift(entry)
  fitCheckpoints(savedCaches.map((e) => e.checkpoints))
  let tokens = savedCaches.reduce((sum, e) => sum + e.ids.length, 0)
  for (let i = savedCaches.length - 1; i >= 1 && tokens > SAVED_TOKENS; i--) {
    const before = savedCaches[i].ids.length
    if (trimSaved(tf, savedCaches[i])) {
      tokens -= before - savedCaches[i].ids.length
      if (DEBUG) {
        ctx.postMessage({
          type: "log",
          text: `[cache] cut a ${before}-token cache to ${savedCaches[i].ids.length}`
        })
      }
    }
  }
  while (
    savedCaches.length > 1 &&
    (savedCaches.length > MAX_SAVED || tokens > SAVED_TOKENS)
  ) {
    const dropped = savedCaches.pop()
    if (!dropped) break
    tokens -= dropped.ids.length
    if (DEBUG) {
      ctx.postMessage({
        type: "log",
        text: `[cache] dropped a ${dropped.ids.length}-token cache`
      })
    }
    void disposeSaved(dropped)
  }
}

/** The conv (and other non-attention) states of a cache, copied. */
function checkpoint(tf: TransformersModule, cache: Cache, length: number) {
  const states: Record<string, Tensor> = {}
  for (const [name, tensor] of cacheTensors(cache)) {
    if (!isKeysValues(name)) states[name] = copyCacheTensor(tf, tensor)
  }
  return { length, states }
}

/**
 * Tokens a match must reach past the system prompt and tools to count as
 * the same chat: role markers and the like are shared by every chat.
 */
const SAME_CHAT_TOKENS = 16

/** A checkpoint's states, copied, for another cache to own. */
const copyCheckpoint = (tf: TransformersModule, c: Checkpoint) => ({
  length: c.length,
  states: Object.fromEntries(
    Object.entries(c.states).map(([name, t]) => [name, copyCacheTensor(tf, t)])
  )
})

/**
 * The kept cache that saves the most reading for a prompt, set up to read
 * the rest. A cache the prompt continues is taken as is, and one it matches
 * into the same chat is taken and cut back to the latest checkpoint it
 * matches. A cache it matches only through the system prompt and tools
 * (`systemEnd` tokens; another chat, or another run of a sub-agent) stays
 * kept for its own chat, and that start is copied out of it instead. None
 * if no cache helps. Always leaves at least the prompt's last token to
 * read. `common` is how far the prompt matched a cache.
 */
function reuseSaved(
  tf: TransformersModule,
  modelId: string,
  ids: Array<number>,
  systemEnd: number
) {
  let best: { index: number; usable: number; common: number } | null = null
  let longestMatch = 0
  const seen: Array<string> = []
  for (const [index, entry] of savedCaches.entries()) {
    if (entry.modelId !== modelId) continue
    const common = reusablePrefixLength(entry.ids, ids)
    if (DEBUG) {
      seen.push(
        `${entry.ids.length} tokens, matches ${common}, checkpoints ${entry.checkpoints.map((c) => c.length).join("/") || "none"}`
      )
    }
    longestMatch = Math.max(longestMatch, common)
    const usable =
      entry.ids.length === common
        ? common
        : (entry.checkpoints.filter((c) => c.length <= common).at(-1)?.length ??
          0)
    if (usable >= SAME_CHAT_TOKENS && (!best || usable > best.usable)) {
      best = { index, usable, common }
    }
  }
  if (DEBUG) {
    ctx.postMessage({
      type: "log",
      text: `[cache] kept caches for a ${ids.length}-token prompt (system and tools ${systemEnd}): ${seen.join("; ") || "none"}`
    })
  }
  if (!best) {
    return {
      cache: null,
      cached: 0,
      checkpoints: [] as Array<Checkpoint>,
      common: longestMatch
    }
  }
  const { common } = best
  const entry = savedCaches[best.index]
  if (entry.ids.length === common) {
    savedCaches.splice(best.index, 1)
    return {
      cache: entry.cache,
      cached: common,
      checkpoints: entry.checkpoints,
      common
    }
  }
  const back = entry.checkpoints.filter((c) => c.length <= common).at(-1)
  if (!back) throw new Error("No checkpoint to go back to.")
  const keysValues = (tensor: Tensor) =>
    copyCacheTensor(tf, tensor, back.length)
  if (back.length > systemEnd + SAME_CHAT_TOKENS) {
    // The same chat: take its cache, cut back.
    savedCaches.splice(best.index, 1)
    const checkpoints = entry.checkpoints.filter((c) => c.length <= common)
    entry.checkpoints
      .filter((c) => c.length > common)
      .forEach(disposeCheckpoint)
    const entries: Record<string, Tensor> = {}
    for (const [name, tensor] of cacheTensors(entry.cache)) {
      entries[name] = isKeysValues(name)
        ? keysValues(tensor)
        : copyCacheTensor(tf, back.states[name])
    }
    entry.cache.update(entries)
    return { cache: entry.cache, cached: back.length, checkpoints, common }
  }
  // Another chat with the same start: copy the start, leave its cache be.
  const entries: Record<string, Tensor> = {}
  for (const [name, tensor] of cacheTensors(entry.cache)) {
    entries[name] = isKeysValues(name)
      ? keysValues(tensor)
      : copyCacheTensor(tf, back.states[name])
  }
  return {
    cache: new tf.DynamicCache(entries),
    cached: back.length,
    checkpoints: entry.checkpoints
      .filter((c) => c.length <= back.length)
      .map((c) => copyCheckpoint(tf, c)),
    common
  }
}

/** One latest prefix per tokenizer, not an unbounded pool of system/tool prompts. */
const systemPrefixes = new WeakMap<Tokenizer, { key: string; tokens: Array<number> }>()

/**
 * How many tokens the system prompt and tools take at the start of a
 * prompt, or 0 if there are none or they can't be told apart.
 */
function systemLength(
  tokenizer: Tokenizer,
  chat: Array<ChatTurn>,
  tools: Array<ToolSpec>,
  thinking: boolean | undefined,
  ids: Array<number>
) {
  const system = chat[0]?.role === "system" ? [chat[0]] : []
  if (system.length === 0 && tools.length === 0) return 0
  try {
    const key = JSON.stringify({ system, tools, thinking })
    let known = systemPrefixes.get(tokenizer)
    if (known?.key !== key) {
      const tokens = systemPrefixTokens(system, messages => {
        const text = tokenizer.apply_chat_template(messages, {
          ...(tools.length > 0 && { tools }),
          add_generation_prompt: false,
          tokenize: false,
          ...(thinking !== undefined && { enable_thinking: thinking })
        })
        return Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number)
      })
      known = { key, tokens }
      systemPrefixes.set(tokenizer, known)
    }
    const prefix = known.tokens
    // Only matching token IDs are reusable. A separately rendered system-only
    // template may end differently for more than a few tokens; that does not
    // invalidate the instruction prefix which actually matches this prompt.
    const common = reusablePrefixLength(prefix, ids)
    // Prefixes below the existing cache-match floor cannot be selected by
    // reuseSaved, so do not allocate recurrent-state checkpoints just for framing.
    return common >= SAME_CHAT_TOKENS ? common : 0
  } catch {
    return 0
  }
}

/*
 * The prompt cache on disk. The cache in memory goes with the page, so the
 * first run of each agent after a reload would read its whole system prompt
 * and tools again (a long one, ~1,300 tokens, takes ~13 s on an iPhone).
 * Each run that reads a system prompt and tools from scratch saves the cache at their end to the Origin Private File System, and a run
 * with nothing in memory covering them loads it from there instead. ~22 KB
 * per token on disk.
 */
const PROMPT_CACHE_DIR = "prompt-cache"
/** The file format; files of other versions are ignored. */
const PROMPT_CACHE_VERSION = 1
/** Shorter system prompts load faster from the model than from disk. */
const MIN_DISK_TOKENS = 64
/** Disk the saved prompt caches may take; the oldest go first. */
const PROMPT_CACHE_BYTES = 200 * 1024 * 1024
/** "LFPC": marks a prompt cache file. */
const PROMPT_CACHE_MAGIC = 0x4350464c
/** Files saved or loaded this session, by key. */
const onDisk = new Set<string>()

/** A file name for a model and the tokens its cache holds (64-bit FNV-1a). */
function promptCacheKey(modelId: string, ids: Array<number>) {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ ids.length
  const mix = (value: number) => {
    a = Math.imul(a ^ value, 0x01000193) >>> 0
    b = Math.imul(b ^ (value + 0x9e3779b9), 0x01000193) >>> 0
  }
  for (let i = 0; i < modelId.length; i++) mix(modelId.charCodeAt(i))
  for (const id of ids) mix(id)
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}.bin`
}

const promptCacheDir = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle(
    PROMPT_CACHE_DIR,
    { create: true }
  )

/** GPUBufferUsage.MAP_READ | COPY_DST. */
const READBACK_USAGE = 0x1 | 0x8

/**
 * Copies a cache tensor (keys/values cut to `length`) off the GPU, or out of
 * its CPU array. The copy is made or queued before this returns, so the
 * tensor can change or go after.
 */
function readCacheTensor(tensor: Tensor, length?: number) {
  if (tensor.location !== "gpu-buffer") {
    const { data, dims } = copyCpuData(tensor, length)
    return {
      type: tensor.ort_tensor.type,
      dims,
      data: Promise.resolve(new Uint8Array(data.buffer))
    }
  }
  const source = tensor.ort_tensor.gpuBuffer
  const device = gpu.device
  if (!source || !device) throw new Error("The model's cache isn't on the GPU.")
  const dims = [...tensor.dims]
  const bytes = tensor.ort_tensor.type === "float16" ? 2 : 4
  let target = dims
  let pieces = 1
  let from = dims.reduce((x, y) => x * y, 1) * bytes
  let to = from
  if (length !== undefined) {
    const [batch, heads, tokens, size] = dims
    target = [batch, heads, length, size]
    pieces = batch * heads
    from = tokens * size * bytes
    to = length * size * bytes
  }
  const staging = device.createBuffer({
    size: pieces * to,
    usage: READBACK_USAGE
  })
  const encoder = device.createCommandEncoder()
  for (let i = 0; i < pieces; i++) {
    encoder.copyBufferToBuffer(source, i * from, staging, i * to, to)
  }
  device.queue.submit([encoder.finish()])
  const data = staging.mapAsync(0x1).then(() => {
    const copy = new Uint8Array(staging.getMappedRange()).slice()
    staging.unmap()
    staging.destroy()
    return copy
  })
  return { type: tensor.ort_tensor.type, dims: target, data }
}

/**
 * Saves a cache's first `ids.length` tokens to disk: the keys/values from
 * the cache and the other states from `at`, the checkpoint at that length.
 */
function saveToDisk(
  modelId: string,
  ids: Array<number>,
  cache: Cache,
  at: Checkpoint
) {
  const key = promptCacheKey(modelId, ids)
  if (onDisk.has(key)) return
  onDisk.add(key)
  let reads: Array<{ name: string } & ReturnType<typeof readCacheTensor>>
  try {
    reads = cacheTensors(cache).map(([name, tensor]) => ({
      name,
      ...(isKeysValues(name)
        ? readCacheTensor(tensor, ids.length)
        : readCacheTensor(at.states[name]))
    }))
  } catch {
    onDisk.delete(key)
    return
  }
  void (async () => {
    const datas = await Promise.all(reads.map((r) => r.data))
    let offset = 0
    const tensors = reads.map((r, i) => {
      const entry = { name: r.name, type: r.type, dims: r.dims, offset }
      offset += datas[i].byteLength
      return { ...entry, size: datas[i].byteLength }
    })
    const header = new TextEncoder().encode(
      JSON.stringify({ version: PROMPT_CACHE_VERSION, modelId, ids, tensors })
    )
    // The data starts 4-byte aligned, for uploading straight from the file.
    const dataStart = Math.ceil((8 + header.byteLength) / 4) * 4
    const prefix = new Uint8Array(dataStart)
    const view = new DataView(prefix.buffer)
    view.setUint32(0, PROMPT_CACHE_MAGIC, true)
    view.setUint32(4, header.byteLength, true)
    prefix.set(header, 8)
    const dir = await promptCacheDir()
    const handle = await openSync(
      await dir.getFileHandle(key, { create: true })
    )
    try {
      handle.truncate(0)
      handle.write(prefix, { at: 0 })
      for (const [i, data] of datas.entries()) {
        handle.write(data, { at: dataStart + tensors[i].offset })
      }
      handle.flush()
    } finally {
      handle.close()
    }
    if (DEBUG) {
      ctx.postMessage({
        type: "log",
        text: `[cache] saved ${ids.length} tokens to disk (${Math.round((dataStart + offset) / 1e6)} MB)`
      })
    }
    await prunePromptCache(dir)
  })().catch(() => onDisk.delete(key))
}

/** Deletes the oldest saved prompt caches past the disk budget. */
async function prunePromptCache(dir: FileSystemDirectoryHandle) {
  const files: Array<File & { key: string }> = []
  for await (const [name, entry] of (
    dir as unknown as {
      entries: () => AsyncIterable<[string, FileSystemHandle]>
    }
  ).entries()) {
    if (entry.kind !== "file") continue
    const file = await (entry as FileSystemFileHandle).getFile()
    files.push(Object.assign(file, { key: name }))
  }
  files.sort((x, y) => y.lastModified - x.lastModified)
  let total = 0
  for (const file of files) {
    total += file.size
    if (total > PROMPT_CACHE_BYTES) {
      await dir.removeEntry(file.key).catch(() => undefined)
      onDisk.delete(file.key)
    }
  }
}

/**
 * Loads the saved cache for exactly these tokens onto the GPU, or into CPU
 * tensors for a model on the CPU, or null if there's none (or it's for
 * another model or format).
 */
async function loadFromDisk(
  tf: TransformersModule,
  modelId: string,
  ids: Array<number>,
  on: Device
): Promise<Cache | null> {
  const key = promptCacheKey(modelId, ids)
  const device = gpu.device
  if (on === "webgpu" && !device) return null
  let buffer: ArrayBuffer
  try {
    const dir = await promptCacheDir()
    buffer = await (
      await (await dir.getFileHandle(key)).getFile()
    ).arrayBuffer()
  } catch {
    return null
  }
  const view = new DataView(buffer)
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== PROMPT_CACHE_MAGIC) {
    return null
  }
  const headerLength = view.getUint32(4, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength))
  ) as {
    version: number
    modelId: string
    ids: Array<number>
    tensors: Array<{
      name: string
      type: string
      dims: Array<number>
      offset: number
      size: number
    }>
  }
  const same =
    header.version === PROMPT_CACHE_VERSION &&
    header.modelId === modelId &&
    header.ids.length === ids.length &&
    header.ids.every((id, i) => id === ids[i])
  if (!same) return null
  const dataStart = Math.ceil((8 + headerLength) / 4) * 4
  const entries: Record<string, Tensor> = {}
  for (const t of header.tensors) {
    if (on === "wasm" || !device) {
      const bytes = buffer.slice(dataStart + t.offset, dataStart + t.offset + t.size)
      const data =
        t.type === "float16" ? new Uint16Array(bytes) : new Float32Array(bytes)
      entries[t.name] = new tf.Tensor(t.type as Tensor["type"], data, t.dims)
      continue
    }
    const gpuBuffer = device.createBuffer({
      size: t.size,
      usage: CACHE_BUFFER_USAGE
    })
    device.queue.writeBuffer(
      gpuBuffer,
      0,
      new Uint8Array(buffer, dataStart + t.offset, t.size)
    )
    entries[t.name] = gpuTensor(tf, gpuBuffer, t.type, t.dims)
  }
  onDisk.add(key)
  return new tf.DynamicCache(entries)
}

/**
 * Reads the prompt from token `from` up to its last token into the cache, a
 * step at a time; generate() reads the last token and replies. Steps also
 * end at each of `stops`, where `onStop` gets the cache.
 */
async function readPrompt(
  tf: TransformersModule,
  model: Model,
  inputIds: Tensor,
  from: number,
  start: Cache | null,
  stopping: StoppingCriteria,
  stops: Array<number>,
  onStop: (cache: Cache, at: number) => void,
  device: Device
) {
  const length = inputIds.dims[1]
  // At least one token is left for generate(), which skips what the cache
  // already holds; with none left it would read the whole prompt again.
  const end = length - 1
  let cache = start
  let step: number | null = null
  for (let at = from; at < end && !stopping.interrupted;) {
    step = nextPromptStep(step, promptRate)
    const stop = promptStepEnd(at, step, end, stops)
    const size = stop - at
    const began = performance.now()
    const outputs = await model.forward({
      input_ids: inputIds.slice(null, [at, stop]),
      attention_mask: tf.ones([1, stop]),
      ...(cache && { past_key_values: cache }),
      // Logits for the last token only (the default here is every token).
      num_logits_to_keep: new tf.Tensor("int64", [1n], [])
    })
    const ms = performance.now() - began
    // Tiny steps are mostly fixed costs: they'd make the rate look slow.
    if (size >= MIN_PROMPT_STEP) promptRate = size / ms
    const entries: Record<string, Tensor> = {}
    for (const [name, tensor] of Object.entries(outputs)) {
      if (name.startsWith("present")) entries[cacheName(name)] = tensor
      else if (tensor.location === "gpu-buffer") tensor.dispose()
    }
    if (cache) cache.update(entries)
    else cache = new tf.DynamicCache(entries)
    if (stops.includes(stop)) onStop(cache, stop)
    at = stop
  }
  return cache
}

/*
 * Sampling, in one pass over the logits each token. Transformers.js's own
 * sampling does the same steps but runs a separate ONNX Runtime session per
 * token for top-k and rebuilds a set of every token so far for the
 * repetition penalty.
 */

/**
 * A logits processor that applies the model card's repetition penalty (to
 * every token in the prompt and reply, as Transformers.js does), keeps the
 * top_k likeliest tokens, draws one at the given temperature, and leaves
 * only it possible.
 */

/**
 * Streams a reply's text as it's generated, decoding only the last few
 * tokens each time. Transformers.js's TextStreamer decodes the whole line so
 * far for every token, which slows down on long lines (thinking is often
 * one long paragraph). Text is held back while it ends in a partial
 * character.
 */
function createStreamer(
  tokenizer: Tokenizer,
  options: {
    skipSpecial: boolean
    onTokens: (tokens: Array<bigint>) => void
    onText: (text: string) => void
  }
) {
  let prompt = true
  let tokens: Array<bigint> = []
  // Text up to `read` has been sent; decoding from `prefix` keeps the
  // spacing of the token before it right.
  let prefix = 0
  let read = 0
  const decode = (from: number, to: number) =>
    from >= to
      ? ""
      : tokenizer.decode(tokens.slice(from, to), {
          skip_special_tokens: options.skipSpecial
        })
  const flush = (final: boolean) => {
    const before = decode(prefix, read)
    const text = decode(prefix, tokens.length)
    if (text.length <= before.length) return
    if (!final && text.endsWith("\uFFFD")) return
    options.onText(text.slice(before.length))
    prefix = read
    read = tokens.length
  }
  return {
    put(value: Array<Array<bigint>>) {
      // generate() first passes the prompt.
      if (prompt) {
        prompt = false
        return
      }
      options.onTokens(value[0])
      tokens.push(...value[0])
      flush(false)
    },
    end() {
      flush(true)
      prompt = true
      tokens = []
      prefix = 0
      read = 0
    }
  }
}

async function generate(...args: Parameters<typeof generateRun>): Promise<RunTimings> {
  const request = new AbortController()
  requests.set(args[0], request)
  try { return await generateRun(...args) }
  finally { requests.delete(args[0]) }
}

async function generateRun(
  id: string,
  chat: Array<ChatTurn>,
  tools: Array<ToolSpec>,
  thinking: boolean | undefined,
  sampling: WorkerSampling,
  maxTokens: number | undefined,
  requestedContext: number | undefined,
  thinkingOpen: string,
  thinkingClose: string,
  thinkingBudgetTokens?: number,
  outputSchema?: object,
  cachePrompt?: boolean
): Promise<RunTimings> {
  // Time to first token counts from here: it includes reading the prompt.
  const requested = performance.now()
  const signal = requests.get(id)?.signal
  signal?.throwIfAborted()
  if (!current) throw new Error("No model loaded.")
  const loaded = current
  const { tf, tokenizer, model, endTokens, device, dtype, ...runtime } =
    await loaded.runtime
  signal?.throwIfAborted()
  // Never past what the model was loaded for, which is also the default.
  const loadedContext = contextFor(runtime.config, loaded.contextLength)
  const contextLength = Math.min(
    requestedContext ?? loadedContext,
    loadedContext
  )
  // The model's caches, in memory and on disk, are by model and the dtype
  // loaded: the dtype decides the cache's tensor types (float16 on the GPU,
  // float32 on the CPU).
  const cacheId = `${loaded.modelId}:${dtype}`
  // Models with a thinking mode reason in a <think> block before answering.
  const prompt = tokenizer.apply_chat_template(chat, {
    ...(tools.length > 0 && { tools }),
    add_generation_prompt: true,
    tokenize: false,
    ...(thinking !== undefined && { enable_thinking: thinking })
  })
  // Some templates open the thinking in the prompt itself (`<think>`,
  // Gemma 4's `<|channel>thought`); start the reply with it too so the
  // thread shows what follows as thinking.
  const startsInThinking = prompt.trimEnd().endsWith(thinkingOpen)
  if (startsInThinking) {
    ctx.postMessage({ type: "token", id, text: thinkingOpen })
  }
  const inputs = tokenizer(prompt, { add_special_tokens: false })
  const ids = Array.from(inputs.input_ids.data, Number)
  gpu.promptTokens = ids.length
  // The reply gets what's left of the context limit.
  const room = contextLength - gpu.promptTokens
  if (room <= 0) {
    throw new ContextLimitError(
      `This session is too long for the model: ${gpu.promptTokens.toLocaleString("en-US")} tokens, and it can read ${contextLength.toLocaleString("en-US")} at most, reply included. Start a new session to keep going.`
    )
  }
  // Thinking takes many more tokens before the answer starts.
  const wanted = maxTokens ?? model.generation_config?.max_new_tokens ?? room
  if (!Number.isSafeInteger(wanted) || wanted < 0) throw new RangeError("maxTokens must be a nonnegative safe integer.")
  const maxNewTokens = Math.min(wanted, room)
  if (maxNewTokens === 0) {
    if (outputSchema !== undefined) throw new Error("Structured output was truncated before a complete schema-valid answer.")
    return { inputTokens: ids.length, cachedTokens: 0, outputTokens: 0, firstTokenMs: null, promptMs: null, decodeMs: 0 }
  }
  const eos = [model.generation_config?.eos_token_id, model.config?.eos_token_id, tokenizer.eos_token_id]
    .flatMap(value => value === undefined ? [] : Array.isArray(value) ? value : [value])
  const open = Array.from(tokenizer(thinkingOpen, { add_special_tokens: false }).input_ids.data, Number)
  const close = Array.from(tokenizer(thinkingClose, { add_special_tokens: false }).input_ids.data, Number)
  const stopping = new tf.InterruptableStoppingCriteria()
  running.set(id, stopping)
  let constraint: Awaited<ReturnType<typeof createConstraint>> | undefined
  try {
    constraint = outputSchema === undefined ? undefined : await createConstraint({ schema: outputSchema, tokenizer, eosTokenId: eos[0], maxTokens: maxNewTokens + 1 })
    signal?.throwIfAborted()
    const controlTokens = thinkingControlTokens(open, close, tokenizer.all_special_ids ?? [], eos)
    const control = new GenerationControl({ promptTokens: ids.length, startsInThinking, open, controlTokens, allowReopen: thinking !== false, forceOpen: !startsInThinking && thinking === true, close, eos, budget: thinkingBudgetTokens, constraint })
    // Every generated token, counted as the streamer gets it (text arrives
    // word by word, later than its tokens).
    let outputTokens = 0
    let firstToken: number | null = null
    let lastToken = 0
    let readStarted = performance.now()
    // What the last run left in the cache that this prompt starts with.
    const retain = cachePrompt !== false
    const systemEnd = retain ? systemLength(tokenizer, chat, tools, thinking, ids) : 0
    // A no-retention call owns a fresh cache. Existing conversation caches are not
    // borrowed, mutated or evicted, and disk state is neither read nor written.
    let reused = retain ? reuseSaved(tf, cacheId, ids, systemEnd) : {
      cache: null,
      cached: 0,
      checkpoints: [] as Array<Checkpoint>,
      common: 0
    }
    const timings = (): RunTimings => ({
      inputTokens: ids.length,
      cachedTokens: reused.cached,
      outputTokens,
      firstTokenMs: firstToken === null ? null : firstToken - requested,
      promptMs: firstToken === null ? null : firstToken - readStarted,
      decodeMs: firstToken === null ? 0 : lastToken - firstToken,
      ...control.stats
    })
    const streamer = createStreamer(tokenizer, {
      // Special tokens stay in the text, all but the end of turn: models mark
      // their tool calls with them (LFM2.5, Gemma 4), and Gemma 4 its
      // thinking and strings.
      skipSpecial: false,
      onTokens: (tokens: Array<bigint>) => {
        lastToken = performance.now()
        firstToken ??= lastToken
        outputTokens += tokens.length
      },
      onText: (raw: string) => {
        const text = raw.replace(endTokens, "")
        if (text) ctx.postMessage({ type: "token", id, text })
      }
    })
    // Prompt reading starts here, for its speed (the model is loaded).
    readStarted = performance.now()
    // Nothing in memory covers the system prompt and tools: try the disk.
    const wantsSystem = retain && reused.cached < systemEnd && systemEnd >= MIN_DISK_TOKENS
    const fromDisk = wantsSystem
      ? await loadFromDisk(tf, cacheId, ids.slice(0, systemEnd), device).catch(
          () => null
        )
      : null
    if (fromDisk) {
      reused.checkpoints.forEach(disposeCheckpoint)
      await reused.cache?.dispose().catch(() => undefined)
      reused = {
        cache: fromDisk,
        cached: systemEnd,
        checkpoints: [checkpoint(tf, fromDisk, systemEnd)],
        common: Math.max(reused.common, systemEnd)
      }
      if (DEBUG) {
        ctx.postMessage({
          type: "log",
          text: `[cache] loaded ${systemEnd} tokens from disk in ${Math.round(performance.now() - readStarted)} ms`
        })
      }
    }
    // This run reads the system prompt and tools from scratch: save them.
    const savesSystem = wantsSystem && !fromDisk
    let cache: Cache | null = reused.cache
    const checkpoints = reused.checkpoints
    /** Every token the model has read, prompt and reply, once it's replied. */
    let sequence: Array<number> = ids
    if (DEBUG) {
      ctx.postMessage({
        type: "log",
        text: `[cache] ${reused.cached} of ${ids.length} prompt tokens already read`
      })
    }
    try {
      signal?.throwIfAborted()
      const addCheckpoint = (at: Cache, length: number) => {
        if (!retain) return
        checkpoints.push(checkpoint(tf, at, length))
        // Keep the oldest (often the end of the system prompt and tools, which
        // new chats share) and the latest.
        fitCheckpoints([checkpoints, ...savedCaches.map((e) => e.checkpoints)])
      }
      // Checkpoints on the way: where the system prompt and tools end, which
      // the next chat or sub-agent run repeats, and where this prompt stopped
      // matching a kept cache past them, which the next prompt may match too.
      const stops = [
        systemEnd,
        reused.common > systemEnd + SAME_CHAT_TOKENS ? reused.common : 0
      ]
        .filter((at) => at > reused.cached && at < ids.length - 1)
        .sort((a, b) => a - b)
      cache = await unlessGpuLost(
        readPrompt(
          tf,
          model,
          inputs.input_ids,
          reused.cached,
          cache,
          stopping,
          stops,
          addCheckpoint,
          device
        )
      )
      if (stopping.interrupted) return timings()
      if (cache) addCheckpoint(cache, ids.length - 1)
      // generate() reads the rest of the prompt and updates the cache in place.
      const output = (await unlessGpuLost(
        model.generate({
          ...inputs,
          ...(cache && {
            past_key_values: cache,
            attention_mask: tf.ones(inputs.input_ids.dims)
          }),
          max_new_tokens: maxNewTokens,
          // The sampler below picks each token and leaves only it possible,
          // so the greedy pick takes it; Transformers.js's own penalty and
          // sampling stay off.
          do_sample: false,
          repetition_penalty: 1,
          logits_processor: [createSampler(sampling, control.prepare)],
          streamer,
          stopping_criteria: [stopping]
        })
      )) as Tensor
      sequence = Array.from(output.data, Number)
      control.finish(sequence, stopping.interrupted)
    } catch (error) {
      // The model's GPU memory is gone with the device: load it again next time.
      if (gpu.lost && current === loaded) current = null
      checkpoints.forEach(disposeCheckpoint)
      checkpoints.length = 0
      await cache?.dispose().catch(() => undefined)
      cache = null
      throw error
    } finally {
      // Keep the cache for the next run. It holds every token it has read
      // (the last token generated isn't read until the next step).
      if (cache && current === loaded && retain) {
        const length = cache.get_seq_length()
        const atSystem = checkpoints.find((c) => c.length === systemEnd)
        if (savesSystem && atSystem && length >= systemEnd) {
          saveToDisk(cacheId, ids.slice(0, systemEnd), cache, atSystem)
        }
        keepSaved(tf, {
          modelId: cacheId,
          ids: sequence.slice(0, length),
          cache,
          checkpoints
        })
      } else if (cache) {
        checkpoints.forEach(disposeCheckpoint)
        await cache.dispose().catch(() => undefined)
      }
    }
    // Cut off by the context limit, not by the reply's own length limit.
    if (
      maxNewTokens < wanted &&
      outputTokens >= maxNewTokens &&
      !stopping.interrupted
    ) {
      throw new ContextLimitError(
        `The reply stopped at the model's limit of ${contextLength.toLocaleString("en-US")} tokens for a session. Start a new session to keep going.`
      )
    }
    return timings()
  } finally {
    running.delete(id)
    constraint?.dispose()
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

ctx.onmessage = ({ data }) => {
  if (data.type === "claimed") {
    claimed?.()
    claimed = null
  } else if (data.type === "load") {
    load(data.modelId, data.dtype, data.contextLength).catch(() => undefined)
  } else if (data.type === "generate") {
    generate(
      data.id,
      data.chat,
      data.tools,
      data.thinking,
      data.sampling,
      data.maxTokens,
      data.contextLength,
      data.thinkingOpen,
      data.thinkingClose,
      data.thinkingBudgetTokens,
      data.outputSchema,
      data.cachePrompt
    )
      .then((stats) => ctx.postMessage({ type: "done", id: data.id, stats }))
      .catch((error: unknown) => {
        if (DEBUG && error instanceof Error) {
          ctx.postMessage({ type: "log", text: `[error] ${error.stack}` })
        }
        ctx.postMessage({
          type: "error",
          id: data.id,
          message:
            error instanceof ContextLimitError
              ? error.message
              : `${errorMessage(error)} (${gpuReport()})`
        })
      })
  } else {
    requests.get(data.id)?.abort()
    running.get(data.id)?.interrupt()
  }
}
