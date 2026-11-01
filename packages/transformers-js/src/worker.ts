/**
 * Runs a local model with Transformers.js on WebGPU, off the main thread so
 * the page stays smooth while it loads and generates. One model at a time:
 * loading another frees the previous one. Transformers.js comes from the CDN
 * at runtime so its native Node dependencies never enter the app build.
 *
 * Without WebGPU (Firefox on Android, say), the same models run on the CPU
 * through ONNX Runtime's WebAssembly backend, from their q4 weights (float32
 * activations, which the CPU kernels want): slower, but the same features,
 * prompt caching in memory and on disk included.
 */
import type {
  ChatTurn,
  RunTimings,
  Sampling,
  ToolSpec,
  WeightsDtype,
  WorkerRequest,
  WorkerResponse
} from "./protocol.js"
import { pooledSize, SparePool } from "./buffer-pool.js"
import {
  MIN_PROMPT_STEP,
  nextPromptStep,
  promptStepEnd
} from "./prompt-steps.js"
import { checkpointsToDrop } from "./checkpoints.js"
import { embedRows } from "./disk-embedding.js"
import {
  chunkLargeMatMulNBits,
  readQuantizedEmbedding,
  scanBodyNodeNames,
  scoreLastTokenOnly,
  trimRotaryTables
} from "./onnx-graph.js"
import type { QuantizedEmbedding } from "./onnx-graph.js"

/**
 * Diagnostics (memory and cache logs, error stacks) when the page started
 * the worker with debug on: it's named "…:debug" then, which the worker can
 * read before any message arrives.
 */
const DEBUG =
  (globalThis as { name?: string }).name?.endsWith(":debug") ?? false

const TRANSFORMERS_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.web.min.js"

/**
 * ONNX Runtime 1.31.1 instead of the September 14 dev build Transformers.js
 * 4.3.2 pins: its WebGPU mixture-of-experts kernel (QMoE) takes a separate
 * gate projection ("FC3"), which Gemma 4's experts use.
 */
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/"

/**
 * The runtime bundle for a device. On the CPU it's the plain WebAssembly
 * build: the WebGPU builds have no CPU kernel for GatherBlockQuantized,
 * the 4-bit embedding lookup most q4 files use, and the plain build is
 * half the size (14.8 MB of WebAssembly against 29).
 */
const ortUrl = (device: Device) =>
  `${ORT_DIST}${device === "wasm" ? "ort.wasm.bundle.min.mjs" : "ort.webgpu.bundle.min.mjs"}`

/**
 * The Cache Storage Transformers.js keeps model files and ONNX Runtime's
 * WebAssembly in. The runtime's own scripts are kept there too, so a model
 * that has loaded once loads again offline.
 */
const RUNTIME_CACHE = "transformers-cache"

/**
 * A file's text from the cache, else from the network (then cached). For
 * files whose URL names their version, which never change.
 */
async function cachedText(url: string) {
  const cache = await caches.open(RUNTIME_CACHE).catch(() => null)
  const hit = await cache?.match(url)
  if (hit) return hit.text()
  const res = await fetchWithoutReferrer(url)
  if (!res.ok) throw new Error(`Couldn't load ${url} (HTTP ${res.status}).`)
  await cache?.put(url, res.clone()).catch(() => undefined)
  return res.text()
}

const moduleUrl = (code: string) =>
  URL.createObjectURL(new Blob([code], { type: "text/javascript" }))

/**
 * Transformers.js's browser build, on the ONNX Runtime above, both from the
 * cache. The build imports ONNX Runtime by package name
 * (`onnxruntime-web/webgpu`, and `onnxruntime-common` for its Tensor class);
 * both are pointed at the one runtime bundle, so Transformers.js and ONNX
 * Runtime share one Tensor class too.
 */
async function importTransformers(device: Device) {
  const [transformers, ort] = await Promise.all([
    cachedText(TRANSFORMERS_URL),
    cachedText(ortUrl(device))
  ])
  const ortModule = moduleUrl(ort)
  const url = moduleUrl(
    transformers.replace(
      /from\s*"onnxruntime-(?:web\/webgpu|common)"/g,
      `from"${ortModule}"`
    )
  )
  try {
    const tf = (await import(/* @vite-ignore */ url)) as TransformersModule
    // The same module instance Transformers.js imported.
    editModels(await import(/* @vite-ignore */ ortModule))
    return tf
  } finally {
    URL.revokeObjectURL(url)
    URL.revokeObjectURL(ortModule)
  }
}

/**
 * The largest 4-bit matrix multiply, as float32 weights, that a model on the
 * CPU runs in one piece. ONNX Runtime's WebAssembly build has no 4-bit
 * kernel: every MatMulNBits call dequantizes its whole weight matrix into a
 * float32 buffer. LFM3's output layer (2,048 x 128,000) needed 1 GB for it,
 * on top of the 1.3 GB model, and WebAssembly memory never shrinks: past an
 * iPhone tab's 2 GB limit. LFM3's layers are 63 MB at most.
 */
const CPU_MATMUL_BYTES = 64 * 1024 * 1024

/** The edits for the model being loaded, set before its sessions are created. */
let modelEdits: {
  modelId: string
  chunkMatMuls: boolean
  positions: number
} | null = null

/** onnxruntime-web, as far as editModels uses it. */
type Ort = {
  InferenceSession: { create: (model: unknown, ...rest: Array<unknown>) => unknown }
  Tensor: new (type: "float32", data: Float32Array, dims: Array<number>) => unknown
}

/**
 * Has ONNX Runtime create sessions from edited models: rotary tables cut to
 * the context the model is loaded for, scores computed for the last token
 * only, and on the CPU, large multiplies split (see CPU_MATMUL_BYTES). A
 * 4-bit embedding session is replaced by a lookup on disk
 * (diskEmbeddingSession). On the GPU, the bodies of Scan loops stay on the
 * CPU (withCpuNodes).
 */
function editModels(ort: Ort) {
  const session = ort.InferenceSession
  const create = session.create.bind(session)
  session.create = (model, ...rest) => {
    if (!(model instanceof Uint8Array) || !modelEdits) return create(model, ...rest)
    const table = readQuantizedEmbedding(model)
    if (table) {
      if (DEBUG) {
        ctx.postMessage({
          type: "log",
          text: `[model] embedding read from disk (${(table.codes.length / 1e6).toFixed(0)} MB not loaded)`
        })
      }
      return Promise.resolve(diskEmbeddingSession(ort, table, modelEdits.modelId))
    }
    let edited = model
    const trimmed = trimRotaryTables(edited, modelEdits.positions)
    if (trimmed) edited = trimmed
    const lastOnly = scoreLastTokenOnly(edited)
    if (lastOnly) edited = lastOnly
    const chunked = modelEdits.chunkMatMuls
      ? chunkLargeMatMulNBits(edited, CPU_MATMUL_BYTES)
      : null
    if (chunked) edited = chunked
    const cpuNodes = scanBodyNodeNames(edited)
    if (DEBUG && (trimmed || lastOnly || chunked || cpuNodes.length > 0)) {
      ctx.postMessage({
        type: "log",
        text: `[model]${trimmed ? ` rotary tables cut to ${modelEdits.positions.toLocaleString("en-US")} positions;` : ""}${lastOnly ? " scores for the last token only;" : ""}${chunked ? " large matrix multiplies split for the CPU;" : ""}${cpuNodes.length > 0 ? ` ${cpuNodes.length} Scan body nodes on the CPU` : ""}`
      })
    }
    const [options, ...more] = rest
    return create(edited, withCpuNodes(options, cpuNodes), ...more)
  }
}

/**
 * Session options with `names` kept on the CPU by the WebGPU provider. The
 * nodes in a Scan's body: ONNX Runtime runs the Scan itself on the CPU, and
 * with the body on the GPU every step of the loop uploaded the state (1 MB
 * per Qwen3.5 layer) and read it back: 82 GB of buffers for a 2,048-token
 * prompt, read at 36 tokens/s on a Mac. With the body on the CPU: 1.9 GB,
 * at 340 tokens/s.
 */
function withCpuNodes(options: unknown, names: Array<string>) {
  const session = options as
    | { executionProviders?: Array<string | { name: string }> }
    | undefined
  if (names.length === 0 || !session?.executionProviders) return options
  return {
    ...session,
    executionProviders: session.executionProviders.map((provider) => {
      const entry = typeof provider === "string" ? { name: provider } : provider
      return entry.name === "webgpu"
        ? { ...entry, forceCpuNodeNames: names }
        : provider
    })
  }
}

/**
 * Stands in for an `embed_tokens` session: looks its tokens' rows up in the
 * weights file instead of holding the table in memory (see
 * disk-embedding.ts). The file is opened on first use: until the model has
 * loaded, the loader holds its only access handle.
 */
function diskEmbeddingSession(
  ort: Ort,
  table: QuantizedEmbedding,
  modelId: string
) {
  let file: Awaited<ReturnType<typeof openWeights>> | null = null
  return {
    inputNames: [table.input],
    outputNames: [table.output],
    async run(
      feeds: Record<string, { data: ArrayLike<bigint>; dims: ReadonlyArray<number> }>
    ) {
      const ids = feeds[table.input]
      file ??= await openWeights(modelId, table.codes.location)
      const { data } = file
      const rows = embedRows(table, ids.data, (offset, length) =>
        data.subarray(offset, offset + length)
      )
      return {
        [table.output]: new ort.Tensor("float32", rows, [...ids.dims, table.K])
      }
    },
    async release() {
      file?.close()
      file = null
    }
  }
}

/* Minimal shapes of the Transformers.js APIs used here. */
/** An onnxruntime-web tensor, as Transformers.js tensors hold them. */
type OrtTensor = {
  type: string
  dims: ReadonlyArray<number>
  gpuBuffer?: GPUBuffer
}
type Tensor = {
  dims: Array<number>
  location?: string
  data: ArrayLike<number | bigint>
  ort_tensor: OrtTensor
  slice: (...ranges: Array<null | [number, number]>) => Tensor
  dispose: () => void
}
/**
 * The model's memory of the text so far: attention keys/values
 * ("past_key_values.*") and conv states ("past_conv.*"), by input name.
 */
type Cache = Record<string, Tensor> & {
  update: (entries: Record<string, Tensor>) => void
  get_seq_length: () => number
  dispose: () => Promise<void>
}
type Tokenizer = {
  chat_template?: string | null
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
  generation_config?: { eos_token_id?: number | Array<number> }
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
  ) => Promise<Model>
}
/** The parts of a model's config.json read here. */
type ModelConfig = {
  architectures?: Array<string>
  max_position_embeddings?: number
  text_config?: { max_position_embeddings?: number }
}
type TransformersModule = Record<string, unknown> & {
  AutoConfig: {
    from_pretrained: (
      id: string,
      options?: Record<string, unknown>
    ) => Promise<ModelConfig>
  }
  AutoTokenizer: {
    from_pretrained: (
      id: string,
      options?: Record<string, unknown>
    ) => Promise<Tokenizer>
  }
  AutoModelForCausalLM: ModelClass
  TextStreamer: new (
    tokenizer: Tokenizer,
    options: Record<string, unknown>
  ) => unknown
  InterruptableStoppingCriteria: new () => StoppingCriteria
  DynamicCache: new (entries: Record<string, Tensor>) => Cache
  Tensor: {
    new (type: string, data: unknown, dims: Array<number>): Tensor
    new (gpu: {
      location: "gpu-buffer"
      gpuBuffer: GPUBuffer
      type: string
      dims: Array<number>
      dispose: () => void
    }): Tensor
  }
  ones: (dims: Array<number>) => Tensor
  env: {
    fetch: typeof fetch
    backends: {
      onnx: {
        versions: { web: string }
        wasm: {
          wasmPaths?: string | { mjs: string; wasm: string }
          numThreads?: number
        }
      }
    }
  }
}

/*
 * ONNX Runtime ships its WebGPU build twice: with Asyncify (the default) and
 * with JSPI. Asyncify rewrites the WebAssembly so it can pause for the GPU,
 * which leaves functions of over 1 MB; Safari's optimizing compiler spent
 * seconds and hundreds of MB on each of them while a reply was generated
 * (on a Mac, the tab peaked at 2,273 MB during a follow-up after a web
 * search, against 1,543 MB with JSPI, and generated ~15% slower). The JSPI
 * build is 16.8 MB instead of 26.9 MB and runs the same code, so it is used
 * wherever the browser has JSPI (Safari 27 and recent Chrome).
 */
function pickWasmBuild(tf: TransformersModule, device: Device) {
  const onnx = tf.env.backends.onnx
  const dist = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${onnx.versions.web}/dist/`
  // On the CPU, the plain build that goes with the plain bundle above.
  const build =
    device === "wasm" ? "" : "Suspending" in WebAssembly ? ".jspi" : ".asyncify"
  // Named as an object, Transformers.js keeps both files in its cache, for
  // loading offline.
  onnx.wasm.wasmPaths = {
    mjs: `${dist}ort-wasm-simd-threaded${build}.mjs`,
    wasm: `${dist}ort-wasm-simd-threaded${build}.wasm`
  }
}

/*
 * Hugging Face answers requests referred from *.workers.dev with a 404 and no
 * CORS headers, which the browser reports as "Failed to fetch". The page's
 * no-referrer meta tag doesn't reach workers, so every request from here
 * leaves the referrer out itself.
 */
const fetchWithoutReferrer: typeof fetch = (input, init) =>
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
  /** Tokens a chat may hold: what the model was loaded for. */
  contextLength: number
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
 * GPU diagnostics, added to generation errors. Safari has no API for memory
 * use, so this counts the WebGPU buffers created and destroyed (nearly all of
 * the model's memory), and records why the device was lost and any GPU error
 * it reported, if those happen.
 */
/** Every live buffer and its size (dev only), for the memory log's breakdown. */
const liveBuffers = new Map<GPUBuffer, number>()

/** Live buffer memory by size, largest totals first: "12x8.4MB=101MB". */
function liveBreakdown() {
  const totals = new Map<number, { count: number; bytes: number }>()
  for (const size of liveBuffers.values()) {
    const entry = totals.get(size) ?? { count: 0, bytes: 0 }
    entry.count++
    entry.bytes += size
    totals.set(size, entry)
  }
  return [...totals]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 8)
    .map(
      ([size, t]) =>
        `${t.count}x${(size / 1e6).toFixed(2)}MB=${Math.round(t.bytes / 1e6)}MB`
    )
    .join(" ")
}

/** Sizes and usages of large buffers created since the last memory log. */
let createdSizes: Array<string> = []

const gpu = {
  /** ONNX Runtime's GPU device, once it has one. */
  device: null as GPUDevice | null,
  liveBytes: 0,
  peakBytes: 0,
  /** The peak since the last memory log line (dev only). */
  linePeakBytes: 0,
  lost: null as string | null,
  error: null as string | null,
  promptTokens: 0,
  /** Running totals of GPU work, for the dev memory log. */
  churn: {
    buffers: 0,
    bufferBytes: 0,
    /** Buffer requests served from the pool. */
    reused: 0,
    bindGroups: 0,
    /** Bind groups the garbage collector has freed. */
    bindGroupsFreed: 0,
    encoders: 0,
    submits: 0,
    maps: 0,
    uploadBytes: 0
  }
}

/*
 * GPU buffers between model steps. ONNX Runtime's default buffer cache
 * ("bucket") keeps the buffers of every size it has made, up to a count per
 * size: after a 2,048-token Qwen3.5 reply it held ~180 MB of sizes it had
 * outgrown, and for sizes past its counts it destroyed a buffer every token
 * (LFM3: 8.4 MB per token at a ~3,000-token prompt, which iPhone Safari
 * reclaimed so late that the page passed its 2 GB limit ~350 tokens into a
 * reply; microsoft/onnxruntime#33751). So ONNX Runtime runs in its
 * "lazyRelease" mode, destroying each step's buffers when the step ends,
 * and the worker keeps them instead (see buffer-pool.ts): the next step
 * takes them back, with sizes rounded up so that a request growing a token
 * at a time keeps its buffer, and what it leaves goes for good. Without the
 * pool, lazyRelease destroys and makes ~41 MB of buffers per Qwen3.5 token.
 */

/** GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE. */
const MAP_READ_OR_WRITE = 0x1 | 0x2
/** GPUBufferUsage.STORAGE. */
const STORAGE_USAGE = 0x80

/** Set while the worker makes a buffer of its own (createOwnBuffer). */
let creatingOwnBuffer = false

/**
 * A buffer for the worker itself (copies of cache tensors): the exact size,
 * and destroyed for real when it goes, never kept as a spare.
 */
function createOwnBuffer(device: GPUDevice, descriptor: GPUBufferDescriptor) {
  creatingOwnBuffer = true
  try {
    return device.createBuffer(descriptor)
  } finally {
    creatingOwnBuffer = false
  }
}

/**
 * Whether a buffer request goes through the pool: ONNX Runtime's storage
 * buffers once the model is loaded (not its weights, which stay, nor
 * buffers for mapping).
 */
const pooled = (descriptor: GPUBufferDescriptor) =>
  !creatingOwnBuffer &&
  modelEdits === null &&
  (descriptor.usage & STORAGE_USAGE) !== 0 &&
  (descriptor.usage & MAP_READ_OR_WRITE) === 0 &&
  !descriptor.mappedAtCreation

/** Spare buffers by device: a lost device's spares are useless to the next. */
const sparePools = new WeakMap<GPUDevice, SparePool<GPUBuffer>>()

/** Ends a model step (a prompt step, a token): drops the spares it left. */
function endGpuStep() {
  if (gpu.device) sparePools.get(gpu.device)?.endStep()
}

/**
 * Destroys every spare buffer: a reply is done, or the next step's buffers
 * are of other sizes. Prompt steps make buffers in proportion to their
 * tokens, so the spares of a 512-token step don't fit a 724-token one:
 * kept, they sat beside its buffers until it ended, and the last step's
 * stayed through the reply's first token (Qwen3.5-2B, 2,048-token prompt:
 * GPU buffers peaked at 1,506 MB, against 1,397 with them dropped).
 */
function dropSpareBuffers() {
  if (gpu.device) sparePools.get(gpu.device)?.clear()
}

/** Bytes held as spares. */
const spareBytes = () =>
  (gpu.device && sparePools.get(gpu.device)?.bytes) || 0

/*
 * Weights go to the GPU in pieces. ONNX Runtime uploads each weight from
 * the weights file through a mapped staging buffer as large as the weight,
 * copied into place and destroyed: up to 254 MB more GPU memory for a
 * moment (Qwen3.5's output layer), and depending on the upload order a
 * load peaked at up to 1,337 MB of GPU buffers against the model's 1,090,
 * with the mapped copies in the page's memory too. While a model loads,
 * that staging buffer is a stand-in instead: its mapped range is the
 * buffer the weight was just read into from disk (loadScratch), and the
 * copy out of it becomes writeBuffer calls of UPLOAD_CHUNK bytes, which the
 * GPU process stages a piece at a time. Only while a model loads: a
 * writeBuffer runs ahead of command buffers recorded before it, which a
 * weight's fresh buffer doesn't mind, but done during a reply it garbled
 * the text.
 */
const UPLOAD_CHUNK = 8 * 1024 * 1024
/** GPUBufferUsage.MAP_WRITE | COPY_SRC: ONNX Runtime's upload staging. */
const UPLOAD_USAGE = 0x2 | 0x4

/**
 * The buffer weights are read into while a model loads, grown to its
 * largest tensor and shared by every weights file. ONNX Runtime copies each
 * slice out (to the GPU, or its own memory) as soon as it gets it. New
 * buffers per slice left the whole file's worth of them for the garbage
 * collector, which iPhone Safari seemed to keep around, compressed,
 * counting against the tab's memory limit.
 */
let loadScratch = new ArrayBuffer(0)

/** The weight just read into loadScratch, for the staging buffer that follows. */
let weightRead: { bytes: number } | null = null

/** Staging stand-ins (see UPLOAD_CHUNK): their device and weight's size. */
const weightStagings = new WeakMap<
  object,
  { device: GPUDevice; bytes: number }
>()

/**
 * A stand-in for the staging buffer ONNX Runtime asks for right after
 * reading a weight, while a model loads; null for any other request.
 */
function weightStaging(owner: GPUDevice, descriptor: GPUBufferDescriptor) {
  const read = weightRead
  weightRead = null
  if (
    !read ||
    modelEdits === null ||
    !descriptor.mappedAtCreation ||
    descriptor.usage !== UPLOAD_USAGE ||
    descriptor.size < read.bytes ||
    descriptor.size > loadScratch.byteLength
  ) {
    return null
  }
  const { size, usage } = descriptor
  const staging = {
    size,
    usage,
    label: descriptor.label ?? "",
    mapState: "mapped",
    getMappedRange: (offset = 0) => {
      if (offset !== 0) throw new Error("Unexpected weight upload.")
      return loadScratch
    },
    unmap: () => undefined,
    destroy: () => undefined
  }
  weightStagings.set(staging, { device: owner, bytes: read.bytes })
  return staging as unknown as GPUBuffer
}

/** Writes a staged weight to its buffer, UPLOAD_CHUNK bytes at a time. */
function uploadWeight(
  staged: { device: GPUDevice; bytes: number },
  destination: GPUBuffer,
  destinationOffset: number,
  size: number
) {
  // The staging buffer is a multiple of 16 bytes; what's past the weight
  // was zeros in ONNX Runtime's.
  new Uint8Array(loadScratch, staged.bytes, size - staged.bytes).fill(0)
  for (let at = 0; at < size; at += UPLOAD_CHUNK) {
    staged.device.queue.writeBuffer(
      destination,
      destinationOffset + at,
      loadScratch,
      at,
      Math.min(UPLOAD_CHUNK, size - at)
    )
  }
}

function trackGpu() {
  const scope = globalThis as unknown as {
    GPUDevice?: { prototype: GPUDevice }
    GPUBuffer?: { prototype: GPUBuffer }
    GPUAdapter?: { prototype: GPUAdapter }
    GPUCommandEncoder?: { prototype: GPUCommandEncoder }
  }
  const device = scope.GPUDevice?.prototype
  const buffer = scope.GPUBuffer?.prototype
  const adapter = scope.GPUAdapter?.prototype
  const encoder = scope.GPUCommandEncoder?.prototype
  if (!device || !buffer || !adapter || !encoder) return
  const sizes = new WeakMap<GPUBuffer, number>()
  /** Pooled buffers: their device and pool key. */
  const owners = new WeakMap<GPUBuffer, { device: GPUDevice; key: string }>()
  /** Buffers sitting in a pool, which ONNX Runtime has destroyed. */
  const spares = new WeakSet<GPUBuffer>()
  const destroy = buffer.destroy
  /** Destroys a buffer for real. */
  const release = (target: GPUBuffer) => {
    owners.delete(target)
    spares.delete(target)
    const size = sizes.get(target)
    if (size !== undefined) {
      gpu.liveBytes -= size
      sizes.delete(target)
      liveBuffers.delete(target)
    }
    destroy.call(target)
  }
  const poolFor = (owner: GPUDevice) => {
    let pool = sparePools.get(owner)
    if (!pool) sparePools.set(owner, (pool = new SparePool(release)))
    return pool
  }
  const createBuffer = device.createBuffer
  device.createBuffer = function (requested) {
    const staging = weightStaging(this, requested)
    if (staging) return staging
    let descriptor = requested
    let key: string | null = null
    if (pooled(descriptor)) {
      descriptor = { ...descriptor, size: pooledSize(descriptor.size) }
      key = `${descriptor.size}/${descriptor.usage}`
      const spare = poolFor(this).take(key)
      if (spare) {
        spares.delete(spare)
        gpu.churn.reused++
        return spare
      }
    }
    const created = createBuffer.call(this, descriptor)
    if (key) owners.set(created, { device: this, key })
    gpu.churn.buffers++
    gpu.churn.bufferBytes += descriptor.size
    if (DEBUG && descriptor.size >= 256 * 1024) {
      createdSizes.push(
        `${(descriptor.size / 1e6).toFixed(1)}MB/u${descriptor.usage}`
      )
    }
    sizes.set(created, descriptor.size)
    if (DEBUG) liveBuffers.set(created, descriptor.size)
    gpu.liveBytes += descriptor.size
    gpu.peakBytes = Math.max(gpu.peakBytes, gpu.liveBytes)
    gpu.linePeakBytes = Math.max(gpu.linePeakBytes, gpu.liveBytes)
    return created
  }
  const copyBufferToBuffer = encoder.copyBufferToBuffer as (
    ...args: Array<unknown>
  ) => void
  encoder.copyBufferToBuffer = function (
    this: GPUCommandEncoder,
    ...args: Array<unknown>
  ) {
    const staged = weightStagings.get(args[0] as object)
    if (!staged) return copyBufferToBuffer.apply(this, args)
    // (source, destination, size?) or (source, sourceOffset, destination,
    // destinationOffset, size?); ONNX Runtime copies a whole staging buffer.
    const [destination, destinationOffset, size, sourceOffset] =
      typeof args[1] === "number"
        ? [args[2], args[3], args[4], args[1]]
        : [args[1], 0, args[2], 0]
    const source = args[0] as GPUBuffer
    if (sourceOffset !== 0) throw new Error("Unexpected weight upload.")
    uploadWeight(
      staged,
      destination as GPUBuffer,
      destinationOffset as number,
      (size as number | undefined) ?? source.size
    )
  } as GPUCommandEncoder["copyBufferToBuffer"]
  buffer.destroy = function () {
    // Already a spare: ONNX Runtime destroyed it twice.
    if (spares.has(this)) return
    const owner = owners.get(this)
    if (!owner) return release(this)
    spares.add(this)
    poolFor(owner.device).put(owner.key, this, sizes.get(this) ?? 0)
  }
  if (DEBUG) countGpuWork()
  const requestDevice = adapter.requestDevice
  adapter.requestDevice = async function (descriptor) {
    const requested = await requestDevice.call(this, descriptor)
    gpu.device = requested
    void requested.lost.then((info) => {
      gpu.lost = `${info.reason}${info.message ? `: ${info.message}` : ""}`
      for (const notify of lostWaiters) notify()
    })
    requested.addEventListener("uncapturederror", (event) => {
      gpu.error = (event as GPUUncapturedErrorEvent).error.message
    })
    return requested
  }
}
trackGpu()

/*
 * Dev-only memory logging. iPhone Safari kills the page at 2 GB, and it has
 * no memory API, so this counts what it can: ONNX Runtime's WebAssembly
 * memory (the WebAssembly memories created here) and the WebGPU buffers.
 */
const wasmMemories = new Set<WebAssembly.Memory>()

function trackWasm() {
  const wasm = WebAssembly as unknown as Record<string, unknown>
  const Memory = WebAssembly.Memory
  wasm.Memory = new Proxy(Memory, {
    construct(target, args: [WebAssembly.MemoryDescriptor]) {
      const memory = Reflect.construct(target, args) as WebAssembly.Memory
      wasmMemories.add(memory)
      return memory
    }
  })
  for (const name of ["instantiate", "instantiateStreaming"]) {
    const original = wasm[name] as
      ((...args: Array<unknown>) => Promise<unknown>) | undefined
    if (!original) continue
    wasm[name] = async function (this: unknown, ...args: Array<unknown>) {
      const result = (await original.apply(this, args)) as {
        instance?: WebAssembly.Instance
        exports?: WebAssembly.Exports
      }
      const exports = result.instance?.exports ?? result.exports ?? {}
      for (const value of Object.values(exports)) {
        if (value instanceof Memory) wasmMemories.add(value)
      }
      return result
    }
  }
}
if (DEBUG) trackWasm()

/** Counts WebGPU objects made and work sent, which buffer sizes don't show. */
function countGpuWork() {
  const scope = globalThis as unknown as {
    GPUDevice?: { prototype: GPUDevice }
    GPUQueue?: { prototype: GPUQueue }
    GPUBuffer?: { prototype: GPUBuffer }
  }
  const device = scope.GPUDevice?.prototype
  const queue = scope.GPUQueue?.prototype
  const buffer = scope.GPUBuffer?.prototype
  if (!device || !queue || !buffer) return
  const count = <T extends object, K extends keyof T>(
    target: T,
    name: K,
    onCall: (args: Array<unknown>) => void
  ) => {
    const original = target[name] as unknown as (
      ...args: Array<unknown>
    ) => unknown
    ;(target as Record<K, unknown>)[name] = function (
      this: unknown,
      ...args: Array<unknown>
    ) {
      onCall(args)
      return original.apply(this, args)
    }
  }
  // Bind groups have no destroy(): their memory goes when they're collected.
  const collected = new FinalizationRegistry(() => gpu.churn.bindGroupsFreed++)
  const createBindGroup = device.createBindGroup
  device.createBindGroup = function (descriptor) {
    const bindGroup = createBindGroup.call(this, descriptor)
    gpu.churn.bindGroups++
    collected.register(bindGroup, null)
    return bindGroup
  }
  count(device, "createCommandEncoder", () => gpu.churn.encoders++)
  count(queue, "submit", () => gpu.churn.submits++)
  count(buffer, "mapAsync", () => gpu.churn.maps++)
  count(queue, "writeBuffer", (args) => {
    const data = args[2] as ArrayBufferView | ArrayBuffer | undefined
    // A size is in elements of a typed array, else bytes.
    const size = args[4] as number | undefined
    const unit =
      (data as { BYTES_PER_ELEMENT?: number } | undefined)
        ?.BYTES_PER_ELEMENT ?? 1
    gpu.churn.uploadBytes +=
      size === undefined ? (data?.byteLength ?? 0) : size * unit
  })
}

let lastChurn = { ...gpu.churn }

/** Logs memory use to the page's console, in dev only. */
function logMemory(step: string) {
  if (!DEBUG) return
  const mb = (bytes: number) => Math.round(bytes / 1e6)
  let wasmBytes = 0
  for (const memory of wasmMemories) wasmBytes += memory.buffer.byteLength
  // What was made and sent since the last line.
  const c = gpu.churn
  const d = (key: keyof typeof c) => c[key] - lastChurn[key]
  const sizes = new Map<string, number>()
  for (const size of createdSizes) sizes.set(size, (sizes.get(size) ?? 0) + 1)
  createdSizes = []
  const largest = [...sizes]
    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
    .slice(0, 6)
    .map(([size, n]) => `${n}x${size}`)
    .join(" ")
  const since = `+${d("buffers")} buffers (${mb(d("bufferBytes"))} MB), ${d("reused")} reused, +${d("bindGroups")} bind groups, +${d("encoders")} encoders, +${d("submits")} submits, +${d("maps")} reads, ${mb(d("uploadBytes"))} MB uploaded; large: ${largest || "none"}`
  lastChurn = { ...c }
  const alive = c.bindGroups - c.bindGroupsFreed
  ctx.postMessage({
    type: "log",
    text: `[memory] ${step}: wasm ${mb(wasmBytes)} MB, GPU buffers ${mb(gpu.liveBytes)} MB (${mb(spareBytes())} MB of them spares; peak ${mb(gpu.linePeakBytes)} MB since the last line, ${mb(gpu.peakBytes)} MB in all), ${alive} bind groups not yet collected; since last: ${since}`
  })
  gpu.linePeakBytes = gpu.liveBytes
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

/**
 * WebKit frees a WebGPU bind group's memory only when its JavaScript object
 * is garbage-collected (there is no destroy()), and until late 2026 a bind
 * group also kept destroyed buffers it pointed at. ONNX Runtime makes ~300
 * bind groups per generated token while the worker's own heap barely grows,
 * so collections rarely ran: iPhone Safari's page grew with every token of a
 * long reply until it passed its 2 GB limit. Allocating throwaway memory
 * makes the engine collect.
 */
function nudgeGarbageCollector() {
  // Only WebGPU's bind groups need it; on the CPU it's just churn.
  if (!gpu.device) return 0
  const junk = Array.from({ length: 32 }, () => new ArrayBuffer(1 << 20))
  return junk.length
}

/** What the GPU looked like when something failed, for the error message. */
function gpuReport() {
  const mb = (bytes: number) => Math.round(bytes / 1e6)
  return [
    // Nothing to say about the GPU for a model on the CPU.
    gpu.device &&
      `GPU buffers: ${mb(gpu.liveBytes)} MB in use, ${mb(gpu.peakBytes)} MB peak`,
    `prompt: ${gpu.promptTokens} tokens`,
    gpu.lost && `device lost: ${gpu.lost}`,
    gpu.error && `GPU error: ${gpu.error}`
  ]
    .filter(Boolean)
    .join("; ")
}

/*
 * The model's weights (`onnx/*_q4f16.onnx_data*`: one 0.76-1.09 GB file for
 * the LFM builds, several ~2 GB parts for larger models) are cached in the
 * Origin Private File System instead of Transformers.js's Cache Storage:
 * Transformers.js 4.3 holds each whole download in memory and copies it
 * again to cache it, which goes past iPhone Safari's 2 GB page limit.
 * Downloading straight to disk and streaming it back in slice by slice
 * avoids both. Transformers.js still fetches and caches the small files.
 */

/** A dtype's weights files, by name in the repo's `onnx` folder. */
const weightsPattern = (dtype: WeightsDtype) =>
  new RegExp(`^[\\w.-]+_${dtype}\\.onnx_data(?:_\\d+)?$`)

/** A weights file of the model, and its size in bytes. */
type WeightsFile = { name: string; size: number }

/**
 * A text model's weights: not a multimodal build's vision or audio encoder,
 * which aren't loaded (see modelClass).
 */
const isTextWeights = ({ name }: WeightsFile) =>
  !/^(?:vision|audio)_encoder_/.test(name)

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
 * Files on disk are named by repo and, for a pinned model, by revision, so
 * a new version is downloaded fresh rather than reusing what an older one
 * saved.
 */
const repoFilePrefix = (repo: string) => `${repo.replace(/[^\w.-]+/g, "_")}.`

const filePrefix = (modelId: string) => {
  const { repo, revision } = parseModelId(modelId)
  const version = revision === "main" ? "" : `${revision.slice(0, 12)}.`
  return `${repoFilePrefix(repo)}${version}`
}

const weightsFile = (modelId: string, name: string) => {
  const { repo, revision } = parseModelId(modelId)
  const file = `${filePrefix(modelId)}${name}`
  return {
    url: `https://huggingface.co/${repo}/resolve/${revision}/onnx/${name}`,
    file,
    /** Written once the download is complete. */
    done: `${file}.done`,
    /**
     * The version (ETag) of a download in progress, so it resumes only
     * from the same version of the file.
     */
    etag: `${file}.etag`
  }
}

/**
 * The model's weights files: listed once by Hugging Face's API, then kept
 * on disk with them, so a downloaded model loads without the network.
 */
async function listWeights(
  modelId: string,
  dtype: WeightsDtype
): Promise<Array<WeightsFile>> {
  const dir = await navigator.storage.getDirectory()
  const saved = `${filePrefix(modelId)}weights.${dtype}.json`
  try {
    const file = await (await dir.getFileHandle(saved)).getFile()
    // (Listings saved before encoders were left out still name them.)
    return (JSON.parse(await file.text()) as Array<WeightsFile>).filter(
      isTextWeights
    )
  } catch {
    // Not listed yet.
  }
  const { repo, revision } = parseModelId(modelId)
  const res = await fetchWithoutReferrer(
    `https://huggingface.co/api/models/${repo}/tree/${revision}/onnx`
  )
  if (!res.ok) {
    throw new Error(`Couldn't list the model's files (HTTP ${res.status}).`)
  }
  const entries = (await res.json()) as Array<{
    type: string
    path: string
    size: number
  }>
  const files = entries
    .filter((e) => e.type === "file")
    .map((e) => ({ name: e.path.replace(/^onnx\//, ""), size: e.size }))
    .filter((f) => weightsPattern(dtype).test(f.name) && isTextWeights(f))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
  if (files.length === 0) {
    throw new Error(`${repo} has no ${dtype} ONNX weights.`)
  }
  const handle = await openSync(
    await dir.getFileHandle(saved, { create: true })
  )
  try {
    handle.truncate(0)
    handle.write(new TextEncoder().encode(JSON.stringify(files)), { at: 0 })
    handle.flush()
  } finally {
    handle.close()
  }
  return files
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

async function hasFile(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

/** Whether every weights file is already downloaded to disk. */
async function isDownloaded(modelId: string, weights: Array<WeightsFile>) {
  try {
    const dir = await navigator.storage.getDirectory()
    for (const { name } of weights) {
      if (!(await hasFile(dir, weightsFile(modelId, name).done))) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Downloads the weights files to disk, one after another, writing each
 * network chunk as it arrives. Progress is in bytes across all of them.
 */
async function downloadWeights(
  modelId: string,
  weights: Array<WeightsFile>,
  onProgress: (loaded: number, total: number) => void
) {
  const dir = await navigator.storage.getDirectory()
  const total = weights.reduce((sum, w) => sum + w.size, 0)
  let before = 0
  for (const file of weights) {
    await downloadFile(
      modelId,
      file,
      (written) => {
        if (total) onProgress(before + written, total)
      },
      dir
    )
    before += file.size
  }
}

/** Tries per weights file before a download fails. */
const DOWNLOAD_ATTEMPTS = 6

class HttpError extends Error {}

/**
 * Downloads one weights file to disk, unless it's there already. A broken
 * connection (common over several GB) doesn't start it over: it retries,
 * with a growing wait, and asks only for the bytes still missing. A file an
 * earlier visit left half-done is continued the same way.
 */
/** A small text file's contents, or "" if there's none. */
async function readText(dir: FileSystemDirectoryHandle, name: string) {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text()
  } catch {
    return ""
  }
}

async function writeText(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string
) {
  const handle = await openSync(await dir.getFileHandle(name, { create: true }))
  try {
    handle.truncate(0)
    handle.write(new TextEncoder().encode(text), { at: 0 })
    handle.flush()
  } finally {
    handle.close()
  }
}

async function downloadFile(
  modelId: string,
  { name, size: listedSize }: WeightsFile,
  onWritten: (bytes: number) => void,
  dir: FileSystemDirectoryHandle
) {
  const files = weightsFile(modelId, name)
  if (await hasFile(dir, files.done)) return
  let handle = await openSync(
    await dir.getFileHandle(files.file, { create: true })
  )
  /**
   * The bytes on disk, through a new handle if the browser closed this one
   * (Safari can, mid-download): retries would otherwise write to the closed
   * one and fail at once. The file is looked up again from the storage root,
   * and made again if it's gone: iPhone Safari sometimes deletes a site's
   * whole storage a few seconds into a page (WebsiteDataStore::removeData in
   * the device log), and the download then starts over.
   */
  const onDisk = async () => {
    try {
      return handle.getSize()
    } catch {
      try {
        handle.close()
      } catch {
        // Already closed.
      }
      dir = await navigator.storage.getDirectory()
      handle = await openSync(
        await dir.getFileHandle(files.file, { create: true })
      )
      return handle.getSize()
    }
  }
  // The listed size, until the server sends the file and says its own: a
  // model followed at main can change between listing and download.
  let size = listedSize
  let written = handle.getSize()
  if (size && written > size) {
    handle.truncate(0)
    written = 0
  }
  // Download speed goes to the console every tenth of the file and at the
  // end, to tell a slow network from a slow phone.
  const started = performance.now()
  const resumedAt = written
  const logSpeed = (label: string) => {
    const seconds = (performance.now() - started) / 1000
    ctx.postMessage({
      type: "log",
      text: `[download] ${name} ${label}: ${Math.round(written / 1e6)} of ${Math.round(size / 1e6)} MB, ${((written - resumedAt) / 1e6 / seconds).toFixed(1)} MB/s`
    })
  }
  try {
    let nextLog = written + size / 10
    // Failures in a row with no bytes gained: a retry that made progress
    // starts the count over.
    let attempt = 1
    // The version on disk, for resuming only from the same version: with
    // If-Range, a server sends the rest if the file is unchanged and the
    // whole new file if it changed.
    let etag = written > 0 ? await readText(dir, files.etag) : ""
    while (!size || written < size) {
      const start = written
      try {
        const headers: Record<string, string> = {}
        if (written > 0) {
          headers.Range = `bytes=${written}-`
          if (etag) headers["If-Range"] = etag
        }
        const res = await fetchWithoutReferrer(files.url, { headers })
        if (!res.ok || !res.body) {
          throw new HttpError(
            `Couldn't download the model (HTTP ${res.status}).`
          )
        }
        if (written > 0 && res.status !== 206) {
          // The whole file: the server ignores ranges, or the file changed.
          handle.truncate(0)
          written = 0
        } else if (written > 0) {
          // A range starting anywhere else would put its bytes in the
          // wrong place: start over instead.
          const range = /^bytes (\d+)-/.exec(
            res.headers.get("Content-Range") ?? ""
          )
          if (range && Number(range[1]) !== written) {
            void res.body.cancel().catch(() => undefined)
            handle.truncate(0)
            written = 0
            etag = ""
            continue
          }
        }
        if (written === 0) {
          // A download from the start: this version's ETag and size.
          etag = res.headers.get("ETag") ?? ""
          await writeText(dir, files.etag, etag)
          const length = Number(res.headers.get("Content-Length"))
          if (length > 0) size = length
        }
        const reader = res.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            written += handle.write(value, { at: written })
            onWritten(written)
            if (size && written >= nextLog && written < size) {
              logSpeed(`${Math.round((written / size) * 100)}%`)
              nextLog += size / 10
            }
          }
        } catch (error) {
          // (A write failed: stop the response rather than let it run on.)
          reader.cancel().catch(() => undefined)
          throw error
        }
        if (!size) break
      } catch (error) {
        if (error instanceof HttpError) throw error
        // Go on from what's on disk (a new handle if this one was closed).
        let reopen = ""
        try {
          written = await onDisk()
        } catch (reopenError) {
          // Reopening failed too: counted as a failed try.
          reopen = `, couldn't reopen the file: ${errorMessage(reopenError)}`
        }
        attempt = written > start ? 1 : attempt + 1
        if (attempt > DOWNLOAD_ATTEMPTS) throw error
        const { usage = 0, quota = 0 } = await navigator.storage
          .estimate()
          .catch(() => ({ usage: 0, quota: 0 }))
        logSpeed(
          `interrupted (${errorMessage(error)}${reopen}; storage ${Math.round(usage / 1e6)} of ${Math.round(quota / 1e6)} MB used), try ${attempt}`
        )
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      }
    }
    handle.truncate(written)
    handle.flush()
    logSpeed("done")
  } finally {
    handle.close()
  }
  await dir.getFileHandle(files.done, { create: true })
  await dir.removeEntry(files.etag).catch(() => undefined)
}

/**
 * Opens the weights on disk as a stand-in for the whole buffer. ONNX Runtime
 * only asks it for its size and for one tensor's slice at a time, so each
 * slice is read from disk when asked and the file never sits in memory.
 * Call close() once the model is created.
 */
async function openWeights(modelId: string, name: string) {
  const dir = await navigator.storage.getDirectory()
  const handle = await openSync(
    await dir.getFileHandle(weightsFile(modelId, name).file)
  )
  const size = handle.getSize()
  const view = new Uint8Array(0)
  Object.defineProperties(view, {
    byteLength: { get: () => size },
    length: { get: () => size },
    subarray: {
      value: (begin = 0, end = size) => {
        const length = end - begin
        // Room for the staging buffer's rounding to 16 bytes too.
        if (loadScratch.byteLength < length) {
          loadScratch = new ArrayBuffer(Math.ceil(length / 16) * 16)
        }
        const slice = new Uint8Array(loadScratch, 0, length)
        handle.read(slice, { at: begin })
        weightRead = { bytes: length }
        return slice
      }
    }
  })
  return {
    data: view,
    close: () => {
      handle.close()
      loadScratch = new ArrayBuffer(0)
    }
  }
}

/**
 * Removes weights earlier versions of the app stored elsewhere, and saved
 * files of other versions of this model.
 */
async function removeOldCopies(modelId: string) {
  try {
    const cache = await caches.open("transformers-cache")
    await cache.delete(weightsFile(modelId, "model_q4f16.onnx_data").url)
    const { repo } = parseModelId(modelId)
    const current = filePrefix(modelId)
    const repoPrefix = repoFilePrefix(repo)
    const dir = await navigator.storage.getDirectory()
    for await (const name of (
      dir as unknown as { keys: () => AsyncIterable<string> }
    ).keys()) {
      // Files of another pinned version ("repo.<commit>.name"); at main,
      // the model's files are "repo.name".
      const pinned = /^[0-9a-f]{12}\./.test(name.slice(repoPrefix.length))
      const otherVersion =
        name.startsWith(repoPrefix) &&
        (current === repoPrefix ? pinned : !name.startsWith(current))
      if (name.startsWith("lfm3-1.7b-") || otherVersion) {
        await dir.removeEntry(name)
      }
    }
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Removes this model's files of another dtype (the q4f16 weights once it
 * loads q4, say), which would otherwise sit on disk unused.
 */
async function removeOtherWeights(
  modelId: string,
  dtype: WeightsDtype,
  weights: Array<WeightsFile>
) {
  try {
    const prefix = filePrefix(modelId)
    const keep = new Set([`${prefix}weights.${dtype}.json`])
    for (const { name } of weights) {
      const files = weightsFile(modelId, name)
      keep.add(files.file).add(files.done).add(files.etag)
    }
    const dir = await navigator.storage.getDirectory()
    const other: Array<string> = []
    for await (const name of (
      dir as unknown as { keys: () => AsyncIterable<string> }
    ).keys()) {
      if (name.startsWith(prefix) && !keep.has(name)) other.push(name)
    }
    for (const name of other) await dir.removeEntry(name)
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
 * multimodal build (`Gemma4ForConditionalGeneration`,
 * `Qwen3_5ForConditionalGeneration`) loads with its family's causal-LM
 * class, which Transformers.js gives just the embedding and decoder, not
 * the vision and audio encoders. Otherwise its own class from the config.
 * A text-only export of a multimodal family
 * (`Gemma4ForCausalLM` with separate `embed_tokens` and
 * `decoder_model_merged` files, no encoders) is loaded the way
 * Transformers.js loads a multimodal model's text part: with the causal-LM
 * class, and a config naming the multimodal architecture, so it reads just
 * those two files.
 */
async function modelClass(
  tf: TransformersModule,
  repo: string,
  revision: string,
  weights: Array<WeightsFile>
) {
  const config = await tf.AutoConfig.from_pretrained(repo, { revision })
  const arch = config.architectures?.[0]
  const textModel = arch?.endsWith("ForConditionalGeneration")
    ? (tf[arch.replace(/ForConditionalGeneration$/, "ForCausalLM")] as
        | ModelClass
        | undefined)
    : undefined
  if (textModel) return { Model: textModel, config }
  const split =
    weights.some((w) => w.name.startsWith("embed_tokens")) &&
    weights.some((w) => w.name.startsWith("decoder_model_merged"))
  if (arch?.endsWith("ForCausalLM") && split) {
    const multimodal = arch.replace(/ForCausalLM$/, "ForConditionalGeneration")
    if (tf[multimodal]) config.architectures = [multimodal]
  }
  const own = arch ? (tf[arch] as ModelClass | undefined) : undefined
  return { Model: own ?? tf.AutoModelForCausalLM, config }
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
  requested: WeightsDtype,
  requestedContext: number | undefined
): Promise<Runtime> {
  const device = await pickDevice()
  // The CPU kernels want float32 activations: q4 weights.
  const dtype: WeightsDtype = device === "wasm" ? "q4" : requested
  let weights: Array<WeightsFile>
  try {
    weights = await listWeights(modelId, dtype)
  } catch (error) {
    if (device === "webgpu") throw error
    throw new Error(
      "This model needs WebGPU, which this browser doesn't have, and it has no weights for running on the CPU. Pick another model."
    )
  }
  void removeOtherWeights(modelId, dtype, weights)
  const cached = await isDownloaded(modelId, weights)
  ctx.postMessage({ type: "progress", modelId, progress: 0, cached })
  // Whole percents only; the download stream reports every chunk.
  let lastPercent = -1
  await downloadWeights(modelId, weights, (loaded, total) => {
    const percent = Math.floor((loaded / total) * 100)
    if (percent === lastPercent) return
    lastPercent = percent
    ctx.postMessage({
      type: "progress",
      modelId,
      progress: percent / 100,
      cached: false,
      loadedBytes: loaded,
      totalBytes: total
    })
  })
  ctx.postMessage({ type: "progress", modelId, progress: 0, cached: true })
  // Room for it first: the page unloads other runtimes' models past the
  // memory budget. On the GPU it takes about its weights (plus the cache);
  // on the CPU, ONNX Runtime's working buffers too.
  const weightBytes = weights.reduce((sum, w) => sum + w.size, 0)
  await claimMemory(modelId, weightBytes * (device === "wasm" ? 1.3 : 1.15))
  const tf = await importTransformers(device)
  tf.env.fetch = fetchWithoutReferrer
  pickWasmBuild(tf, device)
  if (device === "wasm") tf.env.backends.onnx.wasm.numThreads = cpuThreads()
  const { repo, revision } = parseModelId(modelId)
  const tokenizer = await tf.AutoTokenizer.from_pretrained(repo, { revision })
  // Newer repos keep the chat template in its own file, which Transformers.js
  // 4.3 doesn't read.
  if (!tokenizer.chat_template) {
    tokenizer.chat_template = await cachedText(
      `https://huggingface.co/${repo}/resolve/${revision}/chat_template.jinja`
    ).catch(() => null)
  }
  const { Model, config } = await modelClass(tf, repo, revision, weights)
  const contextLength = contextFor(config, requestedContext)
  modelEdits = {
    modelId,
    chunkMatMuls: device === "wasm",
    positions: contextLength
  }
  const opened: Array<Awaited<ReturnType<typeof openWeights>>> = []
  try {
    for (const { name } of weights)
      opened.push(await openWeights(modelId, name))
    const model = await Model.from_pretrained(repo, {
      revision,
      config,
      dtype,
      device,
      // Weights come from disk (above), not Transformers.js's download. Every
      // session gets every file: a decoder may read the embedding's file too.
      use_external_data_format: 0,
      session_options: {
        externalData: weights.map(({ name }, i) => ({
          path: name,
          data: opened[i].data
        })),
        // ONNX Runtime destroys each step's buffers when the step ends
        // ("lazyRelease"), and the worker's pool keeps them for the next
        // step (see sparePools). On its own, lazyRelease made and destroyed
        // ~27 MB of buffers per LFM3 token, which WebKit reclaims late: a
        // long reply climbed past an iPhone's memory limit.
        executionProviders: [
          device === "webgpu"
            ? { name: "webgpu", storageBufferCacheMode: "lazyRelease" }
            : device
        ],
        // No constant folding: LFM exports read the tied embedding's 4-bit
        // weights into the output layer through a Reshape, and folding it
        // copied the whole table into ONNX Runtime's WebAssembly memory
        // (which never shrinks) and, on the GPU, uploaded a second copy.
        // LFM3: 408 MB of WebAssembly memory and 131 MB of GPU memory, past
        // an iPhone tab's 2 GB limit; LFM2-1.2B-Tool: 819 MB. Without it:
        // 17 MB, the same replies and speed, and a load from disk in 1.5 s
        // instead of 21 on a Mac. On the CPU it would also fold the slices
        // chunkModels adds into copies of the weights.
        extra: {
          "optimization.disable_specified_optimizers": "ConstantFolding"
        }
      }
    })
    return {
      tf,
      tokenizer,
      model,
      endTokens: endTokens(tokenizer, model),
      device,
      dtype,
      contextLength
    }
  } finally {
    modelEdits = null
    for (const weightsData of opened) weightsData.close()
  }
}

/**
 * Loads `modelId` for chats of up to `contextLength` tokens (the model's
 * own context window by default), freeing whichever model was loaded
 * before. A different context length loads the model again: its rotary
 * tables are cut to it.
 */
function load(
  modelId: string,
  dtype: WeightsDtype,
  contextLength: number | undefined
) {
  if (
    current?.modelId === modelId &&
    current.dtype === dtype &&
    current.contextLength === contextLength
  ) {
    return current.runtime
  }
  const previous = current?.runtime
  const runtime = (async () => {
    // The kept caches belong to the previous model.
    await discardSaved()
    await previous?.then((r) => r.model.dispose()).catch(() => undefined)
    void removeOldCopies(modelId)
    return loadRuntime(modelId, dtype, contextLength)
  })()
  current = { modelId, dtype, contextLength, runtime }
  runtime.then(
    () => {
      logMemory(`loaded ${modelId}`)
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

/** Below this much room for a reply, the chat is too long to answer. */
const MIN_REPLY_TOKENS = 32

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
  const buffer = createOwnBuffer(device, {
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
 * A tensor over a GPU buffer, which it destroys when disposed. Made from
 * plain fields rather than onnxruntime-web's Tensor.fromGpuBuffer: the
 * Transformers.js bundle has two copies of that class, and wrapping a
 * tensor of the other copy made its dispose() call itself forever.
 */
const gpuTensor = (
  tf: TransformersModule,
  gpuBuffer: GPUBuffer,
  type: string,
  dims: Array<number>
) =>
  new tf.Tensor({
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
    const limit = Math.min(entry.ids.length, ids.length - 1)
    let common = 0
    while (common < limit && entry.ids[common] === ids[common]) common++
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
    const text = tokenizer.apply_chat_template(system, {
      ...(tools.length > 0 && { tools }),
      add_generation_prompt: false,
      tokenize: false,
      ...(thinking !== undefined && { enable_thinking: thinking })
    })
    const prefix = Array.from(
      tokenizer(text, { add_special_tokens: false }).input_ids.data,
      Number
    )
    let common = 0
    const limit = Math.min(prefix.length, ids.length - 1)
    while (common < limit && prefix[common] === ids[common]) common++
    // The last few tokens can differ where the system message ends and the
    // next turn begins (a token merged across the join).
    return common >= prefix.length - 3 ? common : 0
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
      entries[t.name] = new tf.Tensor(t.type, data, t.dims)
      continue
    }
    const gpuBuffer = createOwnBuffer(device, {
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
  onStop: (cache: Cache, at: number) => void
) {
  const length = inputIds.dims[1]
  // At least one token is left for generate(), which skips what the cache
  // already holds; with none left it would read the whole prompt again.
  const end = length - 1
  let cache = start
  let step: number | null = null
  let lastSize = 0
  for (let at = from; at < end && !stopping.interrupted;) {
    step = nextPromptStep(step, promptRate)
    const stop = promptStepEnd(at, step, end, stops)
    const size = stop - at
    // A step of another size takes buffers of other sizes: the last step's
    // spares would only sit beside them until it ends (see dropSpareBuffers).
    if (size !== lastSize) dropSpareBuffers()
    lastSize = size
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
    endGpuStep()
    nudgeGarbageCollector()
    logMemory(
      `prompt read ${stop} of ${length} tokens (${size} in ${Math.round(ms)} ms)`
    )
    at = stop
  }
  // Nor does a reply's first token take a prompt step's buffers.
  dropSpareBuffers()
  logMemory("prompt read, spare buffers dropped")
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
function createSampler({
  temperature,
  top_k,
  repetition_penalty,
  top_p = 1
}: Sampling) {
  const seen = new Set<number>()
  let counted = 0
  return (inputIds: Array<Array<bigint>>, logits: Tensor) => {
    const ids = inputIds[0]
    const data = logits.data as Float32Array
    for (; counted < ids.length; counted++) seen.add(Number(ids[counted]))
    if (repetition_penalty !== 1) {
      for (const token of seen) {
        const x = data[token]
        data[token] = x < 0 ? x * repetition_penalty : x / repetition_penalty
      }
    }
    // The k largest, in no order: replace the smallest kept when beaten.
    const k = Math.max(
      1,
      Math.min(top_k > 0 ? top_k : data.length, data.length)
    )
    const keptIds = new Int32Array(k)
    const kept = new Float32Array(k).fill(-Infinity)
    let smallest = 0
    for (let i = 0; i < data.length; i++) {
      const x = data[i]
      if (x <= kept[smallest]) continue
      kept[smallest] = x
      keptIds[smallest] = i
      smallest = 0
      for (let j = 1; j < k; j++) if (kept[j] < kept[smallest]) smallest = j
    }
    let best = 0
    for (let j = 1; j < k; j++) if (kept[j] > kept[best]) best = j
    let chosen = keptIds[best]
    if (temperature > 0) {
      const max = kept[best]
      let total = 0
      for (let j = 0; j < k; j++) {
        kept[j] = Math.exp((kept[j] - max) / temperature)
        total += kept[j]
      }
      // Top-p: the likeliest tokens until their share reaches top_p; the
      // rest can't be drawn.
      if (top_p < 1) {
        const order = Array.from({ length: k }, (_, j) => j).sort(
          (a, b) => kept[b] - kept[a]
        )
        let share = 0
        let cut = false
        for (const j of order) {
          if (cut) {
            total -= kept[j]
            kept[j] = 0
          } else {
            share += kept[j] / total
            cut = share >= top_p
          }
        }
      }
      let draw = Math.random() * total
      for (let j = 0; j < k; j++) {
        draw -= kept[j]
        if (draw <= 0) {
          chosen = keptIds[j]
          break
        }
      }
    }
    data.fill(-Infinity)
    data[chosen] = 0
    return logits
  }
}

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

async function generate(
  id: string,
  chat: Array<ChatTurn>,
  tools: Array<ToolSpec>,
  thinking: boolean | undefined,
  sampling: Sampling,
  maxTokens: number | undefined,
  requestedContext: number | undefined,
  thinkingOpen: string
): Promise<RunTimings> {
  // Time to first token counts from here: it includes reading the prompt.
  const requested = performance.now()
  if (!current) throw new Error("No model loaded.")
  const loaded = current
  const { tf, tokenizer, model, endTokens, device, dtype, ...runtime } =
    await loaded.runtime
  // Never past what the model was loaded for (its rotary tables end there).
  const contextLength = Math.min(
    requestedContext ?? runtime.contextLength,
    runtime.contextLength
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
  if (prompt.trimEnd().endsWith(thinkingOpen)) {
    ctx.postMessage({ type: "token", id, text: thinkingOpen })
  }
  const inputs = tokenizer(prompt, { add_special_tokens: false })
  const ids = Array.from(inputs.input_ids.data, Number)
  gpu.promptTokens = ids.length
  // The reply gets what's left of the context limit.
  const room = contextLength - gpu.promptTokens
  if (room < MIN_REPLY_TOKENS) {
    throw new ContextLimitError(
      `This session is too long for the model: ${gpu.promptTokens.toLocaleString("en-US")} tokens, and it can read ${contextLength.toLocaleString("en-US")} at most, reply included. Start a new session to keep going.`
    )
  }
  // Thinking takes many more tokens before the answer starts.
  const wanted = maxTokens ?? (thinking === false ? 1024 : 4096)
  const maxNewTokens = Math.min(wanted, room)
  const stopping = new tf.InterruptableStoppingCriteria()
  running.set(id, stopping)
  // Every generated token, counted as the streamer gets it (text arrives
  // word by word, later than its tokens).
  let outputTokens = 0
  let firstToken: number | null = null
  let lastToken = 0
  let readStarted = performance.now()
  // What the last run left in the cache that this prompt starts with.
  const systemEnd = systemLength(tokenizer, chat, tools, thinking, ids)
  let reused = reuseSaved(tf, cacheId, ids, systemEnd)
  const timings = (): RunTimings => ({
    inputTokens: ids.length,
    cachedTokens: reused.cached,
    outputTokens,
    firstTokenMs: firstToken === null ? null : firstToken - requested,
    promptMs: firstToken === null ? null : firstToken - readStarted,
    decodeMs: firstToken === null ? 0 : lastToken - firstToken
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
      endGpuStep()
      if (outputTokens % 16 === 0) nudgeGarbageCollector()
      if (outputTokens % 32 === 0) {
        logMemory(`reply ${outputTokens} tokens (prompt ${gpu.promptTokens})`)
      }
    },
    onText: (raw: string) => {
      const text = raw.replace(endTokens, "")
      if (text) ctx.postMessage({ type: "token", id, text })
    }
  })
  // Prompt reading starts here, for its speed (the model is loaded).
  readStarted = performance.now()
  // Nothing in memory covers the system prompt and tools: try the disk.
  const wantsSystem = reused.cached < systemEnd && systemEnd >= MIN_DISK_TOKENS
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
    const addCheckpoint = (at: Cache, length: number) => {
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
        addCheckpoint
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
        logits_processor: [createSampler(sampling)],
        streamer,
        stopping_criteria: [stopping]
      })
    )) as Tensor
    sequence = Array.from(output.data, Number)
  } catch (error) {
    // The model's GPU memory is gone with the device: load it again next time.
    if (gpu.lost && current === loaded) current = null
    checkpoints.forEach(disposeCheckpoint)
    checkpoints.length = 0
    await cache?.dispose().catch(() => undefined)
    cache = null
    throw error
  } finally {
    running.delete(id)
    // Keep the cache for the next run. It holds every token it has read
    // (the last token generated isn't read until the next step).
    if (cache && current === loaded) {
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
    dropSpareBuffers()
    logMemory(`reply finished, ${outputTokens} tokens`)
    if (DEBUG) {
      ctx.postMessage({
        type: "log",
        text: `[memory] live buffers: ${liveBreakdown()}`
      })
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
      data.thinkingOpen
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
    running.get(data.id)?.interrupt()
  }
}
