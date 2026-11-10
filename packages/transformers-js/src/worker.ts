/**
 * The Transformers.js worker: loads one model (its tokenizer and causal LM)
 * and generates with Transformers.js's own `generate()`, sampling and
 * `TextStreamer`, streaming the text back to the page. A generation that
 * continues the previous one (its prompt starts with every token the last
 * one held) reuses that generation's cache.
 */
import {
  AutoModelForCausalLM,
  AutoTokenizer,
  env,
  InterruptableStoppingCriteria,
  StoppingCriteriaList,
  TextStreamer
} from "@huggingface/transformers"
import type { DynamicCache, PreTrainedModel, PreTrainedTokenizer, ProgressInfo, Tensor } from "@huggingface/transformers"

import type { Device, GenerateRequest, LoadSettings, WorkerReply, WorkerRequest } from "./protocol.js"
import { shownText } from "./tool-calls.js"

const scope = self as unknown as {
  postMessage(reply: WorkerReply): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const post = (reply: WorkerReply) => scope.postMessage(reply)

let loaded: { tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null = null
const stopping = new InterruptableStoppingCriteria()
/** The last generation's cache, and the tokens in it (prompt and reply). */
let reuse: { cache: DynamicCache; tokens: Array<number> } | null = null

async function dropCache() {
  const cache = reuse?.cache
  reuse = null
  await cache?.dispose().catch(() => undefined)
}

/** WebGPU where the browser gives a GPU adapter, else the CPU through WebAssembly. */
async function pickDevice(): Promise<Device> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  try {
    return gpu && (await gpu.requestAdapter()) ? "webgpu" : "wasm"
  } catch {
    return "wasm"
  }
}

/** Transformers.js's progress across the model's files, as 0 to 1, at most every 100 ms. */
function progressReporter() {
  let last = 0
  return (info: ProgressInfo) => {
    if (info.status !== "progress_total" || !info.total) return
    const now = performance.now()
    if (now - last < 100 && info.loaded < info.total) return
    last = now
    post({ status: "progress", progress: Math.min(1, info.loaded / info.total) })
  }
}

/** A repo's `chat_template.jinja`, for tokenizers whose config has no template. */
async function standaloneTemplate(model: string): Promise<string | null> {
  const path = env.remotePathTemplate.replaceAll("{model}", model).replaceAll("{revision}", "main")
  const response = await fetch(`${env.remoteHost}${path}chat_template.jinja`).catch(() => null)
  return response?.ok ? response.text() : null
}

async function load({ model: id, device, dtype }: LoadSettings) {
  const previous = loaded
  loaded = null
  await dropCache()
  await previous?.model.dispose()
  const on = device ?? (await pickDevice())
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(id),
    AutoModelForCausalLM.from_pretrained(id, {
      device: on,
      // fp16 activations on the GPU; the CPU kernels want fp32 ones.
      dtype: dtype ?? (on === "webgpu" ? "q4f16" : "q4"),
      progress_callback: progressReporter(),
      // ONNX Runtime's constant folding copies a tied embedding table read
      // through a Reshape or Transpose (LFM's) into a second, full copy.
      session_options: { extra: { "optimization.disable_specified_optimizers": "ConstantFolding" } }
    })
  ])
  tokenizer.chat_template ??= await standaloneTemplate(id)
  // A first token compiles the GPU's shaders, so the first reply doesn't wait for it.
  await model.generate({ ...tokenizer("a"), max_new_tokens: 1 })
  loaded = { tokenizer, model }
  post({ status: "ready" })
}

const tokenIds = (tensor: Tensor) => Array.from(tensor.data as ArrayLike<number | bigint>, Number)

const startsWith = (tokens: Array<number>, prefix: Array<number>) =>
  prefix.length <= tokens.length && prefix.every((token, i) => token === tokens[i])

async function generate({ messages, options, tools, enableThinking }: GenerateRequest) {
  if (!loaded) throw new Error("No model is loaded.")
  const { tokenizer, model } = loaded
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
    ...(tools && { tools }),
    ...(enableThinking && { enable_thinking: true })
  }) as unknown as { input_ids: Tensor; attention_mask: Tensor }
  const prompt = tokenIds(inputs.input_ids)
  if (reuse && !startsWith(prompt, reuse.tokens)) await dropCache()
  // A thought the chat template opened in the prompt (Qwen3.5's): the reply starts inside it.
  if (/<think>\s*$/.test(tokenizer.decode(prompt.slice(-8)))) post({ status: "update", output: "<think>" })

  let outputTokens = 0
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (text: string) => {
      const output = shownText(text)
      if (output) post({ status: "update", output })
    },
    token_callback_function: () => outputTokens++
  })
  const stoppingCriteria = new StoppingCriteriaList()
  stoppingCriteria.push(stopping)
  const settings = {
    ...inputs,
    ...options,
    streamer,
    stopping_criteria: stoppingCriteria,
    return_dict_in_generate: true
  }
  let output: unknown
  try {
    output = await model.generate({ ...settings, ...(reuse && { past_key_values: reuse.cache }) })
  } catch (error) {
    // A cache the model won't take: once more without it.
    if (!reuse || outputTokens > 0) throw error
    await dropCache()
    output = await model.generate(settings)
  }
  const { sequences, past_key_values } = output as { sequences: Tensor; past_key_values?: DynamicCache }
  reuse = past_key_values ? { cache: past_key_values, tokens: tokenIds(sequences) } : null
  post({ status: "complete", inputTokens: prompt.length, outputTokens })
}

const fail = (error: unknown) => post({ status: "error", message: error instanceof Error ? error.message : String(error) })

scope.onmessage = ({ data }) => {
  if (data.type === "load") void load(data.settings).catch(fail)
  else if (data.type === "interrupt") stopping.interrupt()
  else {
    stopping.reset()
    void generate(data).catch(fail)
  }
}
