/**
 * The model's side of the protocol (protocol.ts): loads one model (its
 * tokenizer and causal LM, or for images its processor and
 * image-text-to-text model) and generates with Transformers.js's own
 * `generate()`, sampling and `TextStreamer`, streaming the text back. A
 * generation that continues the previous one (its prompt starts with every
 * token the last one held) reuses that generation's cache.
 *
 * It runs in the package's worker (worker.ts), in a worker of your own
 * (`self.onmessage = (event) => handler.onmessage(event)`), or on a server
 * in the page's own process, where the client hands it the replies' way back.
 */
import {
  AutoModelForCausalLM,
  AutoModelForImageTextToText,
  AutoProcessor,
  AutoTokenizer,
  env,
  InterruptableStoppingCriteria,
  Lfm2VlProcessor,
  Lfm3VlProcessor,
  RawImage,
  StoppingCriteriaList,
  TextStreamer
} from "@huggingface/transformers"
import type { DynamicCache, PreTrainedModel, PreTrainedTokenizer, Processor, ProgressInfo, Tensor } from "@huggingface/transformers"

import type { Device, GenerateRequest, LoadSettings, WorkerReply, WorkerRequest } from "./protocol.js"
import { shownText } from "./tool-calls.js"

type Loaded = { tokenizer: PreTrainedTokenizer; processor: Processor | null; model: PreTrainedModel }

/** Whether this is Node.js, where Transformers.js runs ONNX Runtime's native build. */
const onNode = () => (globalThis as { process?: { release?: { name?: string } } }).process?.release?.name === "node"

/**
 * WebGPU where the browser gives a GPU adapter, else the CPU: through
 * WebAssembly in a browser, ONNX Runtime's own CPU build on a server.
 */
async function pickDevice(): Promise<Device | "cpu"> {
  if (onNode()) return "cpu"
  const gpu = (globalThis.navigator as (Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }) | undefined)?.gpu
  try {
    return gpu && (await gpu.requestAdapter()) ? "webgpu" : "wasm"
  } catch {
    return "wasm"
  }
}

/** A repo's `chat_template.jinja`, for tokenizers whose config has no template. */
async function standaloneTemplate(model: string): Promise<string | null> {
  const path = env.remotePathTemplate.replaceAll("{model}", model).replaceAll("{revision}", "main")
  const response = await fetch(`${env.remoteHost}${path}chat_template.jinja`).catch(() => null)
  return response?.ok ? response.text() : null
}

const tokenIds = (tensor: Tensor) => Array.from(tensor.data as ArrayLike<number | bigint>, Number)

const startsWith = (tokens: Array<number>, prefix: Array<number>) =>
  prefix.length <= tokens.length && prefix.every((token, i) => token === tokens[i])

/**
 * The prompt's inputs: the chat template's tokens, or for a conversation
 * with images, the processor's (tokens and the images' pixels). The
 * processor is called as `processor(text, images)`, as Qwen's and
 * SmolVLM's are; LFM's take the images first, and tokenize without adding
 * the start token the chat template already wrote.
 */
async function promptInputs(
  { messages, tools, enableThinking, images }: GenerateRequest,
  { tokenizer, processor }: Loaded
): Promise<{ input_ids: Tensor; [name: string]: unknown }> {
  const template = { add_generation_prompt: true, ...(tools && { tools }), ...(enableThinking && { enable_thinking: true }) }
  if (!images?.length) {
    return tokenizer.apply_chat_template(messages as never, { ...template, return_dict: true }) as never
  }
  if (!processor) throw new Error("The model was loaded without its vision encoder.")
  const text = tokenizer.apply_chat_template(messages as never, { ...template, tokenize: false }) as string
  const pixels = await Promise.all(images.map((url) => RawImage.read(url)))
  const imagesFirst = processor instanceof Lfm2VlProcessor || processor instanceof Lfm3VlProcessor
  return (await (imagesFirst ? processor(pixels, text, { add_special_tokens: false }) : processor(text, pixels))) as never
}

/** A cache's length in tokens, or undefined where it can't be told (a cache with no attention layers). */
function cacheLength(cache: DynamicCache): number | undefined {
  try {
    return cache.get_seq_length()
  } catch {
    return undefined
  }
}

export class TransformersJsWorkerHandler {
  private loaded: Loaded | null = null
  private readonly stopping = new InterruptableStoppingCriteria()
  /** The last generation's cache, and the tokens in it (prompt and reply). */
  private reuse: { cache: DynamicCache; tokens: Array<number> } | null = null
  private readonly post: (reply: WorkerReply) => void

  /** `post` sends a reply to the page: the worker's own `postMessage` by default. */
  constructor(post?: (reply: WorkerReply) => void) {
    this.post = post ?? ((reply) => (self as unknown as { postMessage(reply: WorkerReply): void }).postMessage(reply))
  }

  /** A message from the page: `self.onmessage = (event) => handler.onmessage(event)`. */
  onmessage({ data }: { data: WorkerRequest }): void {
    const fail = (error: unknown) => this.post({ status: "error", message: error instanceof Error ? error.message : String(error) })
    if (data.type === "load") void this.load(data.settings).catch(fail)
    else if (data.type === "interrupt") this.stopping.interrupt()
    else if (data.type === "unload") void this.unload().then(() => this.post({ status: "unloaded" }), fail)
    else {
      this.stopping.reset()
      void this.generate(data).catch(fail)
    }
  }

  private async dropCache() {
    const cache = this.reuse?.cache
    this.reuse = null
    await cache?.dispose().catch(() => undefined)
  }

  private async unload() {
    const previous = this.loaded
    this.loaded = null
    await this.dropCache()
    await previous?.model.dispose()
  }

  /** Transformers.js's progress across the model's files, as 0 to 1, at most every 100 ms. */
  private progressReporter() {
    let last = 0
    return (info: ProgressInfo) => {
      if (info.status !== "progress_total" || !info.total) return
      const now = performance.now()
      if (now - last < 100 && info.loaded < info.total) return
      last = now
      this.post({ status: "progress", progress: Math.min(1, info.loaded / info.total) })
    }
  }

  private async load({ model: id, device, dtype, vision, localModelPath, cacheDir }: LoadSettings) {
    await this.unload()
    if (localModelPath !== undefined) env.localModelPath = localModelPath
    if (cacheDir !== undefined) env.cacheDir = cacheDir
    const picked = device ?? (await pickDevice())
    // The CPU is "wasm" in a browser and "cpu" on a server.
    const on = picked === "webgpu" ? picked : onNode() ? "cpu" : "wasm"
    const options = {
      device: on,
      // fp16 activations on the GPU; the CPU kernels want fp32 ones.
      dtype: dtype ?? (on === "webgpu" ? "q4f16" : "q4"),
      progress_callback: this.progressReporter(),
      // ONNX Runtime's constant folding copies a tied embedding table read
      // through a Reshape or Transpose (LFM's) into a second, full copy.
      session_options: { extra: { "optimization.disable_specified_optimizers": "ConstantFolding" } }
    } as const
    const [processor, tokenizer, model] = vision
      ? await Promise.all([AutoProcessor.from_pretrained(id), null, AutoModelForImageTextToText.from_pretrained(id, options)]).then(
          ([processor, , model]) => [processor, processor.tokenizer as PreTrainedTokenizer, model] as const
        )
      : await Promise.all([null, AutoTokenizer.from_pretrained(id), AutoModelForCausalLM.from_pretrained(id, options)])
    tokenizer.chat_template ??= await standaloneTemplate(id)
    // A first token compiles the GPU's shaders, so the first reply doesn't wait for it.
    await model.generate({ ...tokenizer("a"), max_new_tokens: 1 })
    this.loaded = { tokenizer, processor, model }
    this.post({ status: "ready" })
  }

  private async generate(request: GenerateRequest) {
    const loaded = this.loaded
    if (!loaded) throw new Error("No model is loaded.")
    const { tokenizer, model } = loaded
    const withImages = !!request.images?.length
    const inputs = await promptInputs(request, loaded)
    const prompt = tokenIds(inputs.input_ids)
    // An image's tokens are the same placeholder whatever the image: a cache is reused for text only.
    if (this.reuse && (withImages || !startsWith(prompt, this.reuse.tokens))) await this.dropCache()
    // The prompt tokens the reused cache holds: generate() reads only the rest.
    let cachedTokens = this.reuse ? cacheLength(this.reuse.cache) : 0
    // A thought the chat template opened in the prompt (Qwen3.5's): the reply starts inside it.
    if (/<think>\s*$/.test(tokenizer.decode(prompt.slice(-8)))) this.post({ status: "update", output: "<think>" })

    let outputTokens = 0
    const specialTokens = new Set(tokenizer.all_special_tokens)
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (text: string) => {
        const output = shownText(text, specialTokens)
        if (output) this.post({ status: "update", output })
      },
      token_callback_function: () => outputTokens++
    })
    const stoppingCriteria = new StoppingCriteriaList()
    stoppingCriteria.push(this.stopping)
    const settings = {
      ...inputs,
      ...request.options,
      streamer,
      stopping_criteria: stoppingCriteria,
      return_dict_in_generate: true
    }
    let output: unknown
    try {
      output = await model.generate({ ...settings, ...(this.reuse && { past_key_values: this.reuse.cache }) })
    } catch (error) {
      // A cache the model won't take: once more without it.
      if (!this.reuse || outputTokens > 0) throw error
      await this.dropCache()
      cachedTokens = 0
      output = await model.generate(settings)
    }
    const { sequences, past_key_values } = output as { sequences: Tensor; past_key_values?: DynamicCache }
    if (withImages) await past_key_values?.dispose().catch(() => undefined)
    this.reuse = past_key_values && !withImages ? { cache: past_key_values, tokens: tokenIds(sequences) } : null
    this.post({
      status: "complete",
      inputTokens: prompt.length,
      ...(cachedTokens !== undefined && { cachedTokens }),
      outputTokens
    })
  }
}
