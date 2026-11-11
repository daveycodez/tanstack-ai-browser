/**
 * Tool-call check: prompts that need a tool, rendered with the model's chat
 * template (thinking off), as token ids from /ref/<set>/tool_prompts.json
 * (made by tool-ref/). For each: the probability that the reply starts with
 * <tool_call>, the top token, and KL against each CPU reference listed in
 * the file's `refs` (/ref/<set>/logits_<name>.bin) at that position, then a
 * 48-token greedy reply. Runs on webgllm (GGUF or ONNX; token ids in with
 * `forwardTokensAndSample`, logits out through a `LogitProcessor` in
 * tools-logits-worker.ts) or on Transformers.js (WebGPU, q4f16), the way
 * the app runs each. webgllm's side runs on the page, which starts the
 * model's worker (tools.html); Transformers.js's in a worker
 * (tools-worker.ts).
 *
 *   ?set=lfm3&runtime=webgl&format=onnx&onnx=onnx-community
 *   ?set=lfm3&runtime=webgl&format=gguf&model=LFM3-1.7B-QAD-Q4_0.gguf
 *   ?set=lfm3&runtime=tjs&onnx=onnx-community
 */
import { WebGLLM } from "webgllm"

/** Where the check's lines and its result go: set by `main`. */
export type Output = { log(text: string): void; result(value: unknown): void }
let log: Output["log"] = () => undefined
let result: Output["result"] = () => undefined

type Prompts = {
  tool_call_id: number
  eos_id: number
  vocab: number
  prompts: Array<{ question: string; ids: Array<number> }>
  /** CPU references with logits at each prompt's reply position, closest to the runtime first. */
  refs?: Array<string>
}

export type Params = {
  /** The reference set: /ref/<set>/. */
  set?: string
  runtime: "webgl" | "tjs"
  format?: "gguf" | "onnx"
  onnx?: string
  /** The ONNX graph's path in its directory (default onnx/model_q4f16.onnx). */
  graph?: string
  model?: string
  steps?: number
}

let refDir = "/ref/lfm3/"

async function refRow(file: string, V: number, row: number) {
  const res = await fetch(`${refDir}${file}`, {
    headers: { Range: `bytes=${row * V * 4}-${(row + 1) * V * 4 - 1}` }
  })
  if (!res.ok) throw new Error(`${refDir}${file}: ${res.status}`)
  return new Float32Array(await res.arrayBuffer())
}

function softmax(logits: ArrayLike<number>, n: number) {
  let mx = -Infinity
  for (let i = 0; i < n; i++) mx = Math.max(mx, logits[i])
  let sum = 0
  const p = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    p[i] = Math.exp(logits[i] - mx)
    sum += p[i]
  }
  for (let i = 0; i < n; i++) p[i] /= sum
  return p
}

function argmax(a: ArrayLike<number>, n = a.length) {
  let best = 0
  for (let i = 1; i < n; i++) if (a[i] > a[best]) best = i
  return best
}

/** KL(want || got) over the first V entries. */
function kl(got: ArrayLike<number>, want: ArrayLike<number>, V: number) {
  const p = softmax(want, V)
  const q = softmax(got, V)
  let sum = 0
  for (let i = 0; i < V; i++)
    if (p[i] > 0) sum += p[i] * Math.log(p[i] / Math.max(q[i], 1e-30))
  return sum
}

/** A runtime: the logits after a prompt, and a greedy reply. */
type Runner = {
  label: string
  first(ids: Array<number>): Promise<Float32Array>
  greedy(ids: Array<number>, first: Float32Array, steps: number, eos: number): Promise<Array<number>>
}

async function webgl(params: Params): Promise<Runner> {
  const t0 = performance.now()
  // A model hosted here loads by the URL of its file, with its tokenizer files beside it.
  const path =
    params.format === "gguf"
      ? `/models/${params.model ?? "LFM3-1.7B-QAD-Q4_0.gguf"}`
      : `/${params.onnx ?? "onnx-community"}/${params.graph ?? "onnx/model_q4f16.onnx"}`
  const model = new URL(path, location.href).href
  const label = params.format === "gguf" ? `WebGL GGUF ${path.slice("/models/".length)}` : `WebGL ONNX /${params.onnx ?? "onnx-community"}`
  log(`loading ${model}`)
  const worker = new Worker("/bundle/bench/tools-logits-worker.js", { type: "module" })
  /** The last forward's logits, as the worker's logit processor sent them. */
  let logits: Float32Array | null = null
  worker.addEventListener("message", ({ data }: MessageEvent<{ type?: string; logits?: Float32Array }>) => {
    if (data.type === "tools-logits" && data.logits) logits = data.logits
  })
  worker.postMessage({ type: "tools-model", model })
  const webgllm = new WebGLLM({ worker })
  let shown = -25
  await webgllm.loadModel(model, {
    onProgress: ({ phase, progress }) => {
      const percent = Math.floor(progress * 100)
      if (percent < shown + 25) return
      shown = percent
      log(`${phase} ${percent}%`)
    }
  })
  log(`${label} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  /** Reads `ids` after what the cache holds: the next token (the top one), and the logits it came from. */
  const forward = async (ids: Array<number>) => {
    logits = null
    const next = await webgllm.forwardTokensAndSample(ids, false)
    if (!logits) throw new Error("The worker sent no logits for the forward.")
    return { next, logits: logits as Float32Array }
  }
  return {
    label,
    async first(ids) {
      await webgllm.resetChat()
      return (await forward(ids)).logits
    },
    async greedy(_ids, first, steps, eos) {
      const out: Array<number> = []
      let t = argmax(first)
      for (let i = 0; i < steps; i++) {
        out.push(t)
        if (t === eos || i === steps - 1) break
        t = (await forward([t])).next
      }
      return out
    }
  }
}

type Tensor = { type: string; dims: Array<number>; data: ArrayLike<number> | BigInt64Array }

function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

function asFloat32(t: Tensor): Float32Array {
  if (t.type === "float32") return t.data as Float32Array
  if (t.type === "float16") {
    const d = t.data
    if (d instanceof Uint16Array) return Float32Array.from(d, halfToFloat)
    return Float32Array.from(d as ArrayLike<number>)
  }
  throw new Error(`logits of type ${t.type}`)
}

type ModelClass = {
  from_pretrained(
    id: string,
    options: Record<string, unknown>
  ): Promise<{
    (inputs: Record<string, unknown>): Promise<{ logits: Tensor }>
    generate(options: Record<string, unknown>): Promise<Tensor>
  }>
}

async function tjs(params: Params): Promise<Runner> {
  const tf = (await import("@huggingface/transformers")) as unknown as {
    env: {
      allowLocalModels: boolean
      allowRemoteModels: boolean
      localModelPath: string
      useBrowserCache: boolean
    }
    Tensor: new (type: string, data: unknown, dims: Array<number>) => Tensor
  } & Record<string, ModelClass>
  tf.env.allowLocalModels = true
  tf.env.allowRemoteModels = false
  tf.env.localModelPath = `${location.origin}/`
  // Read what the server serves now: Transformers.js keeps fetched files in
  // Cache Storage by URL, and /onnx-web/ serves different models from run to run.
  tf.env.useBrowserCache = false
  const dir = params.onnx ?? "onnx-community"
  // As the app's worker: a multimodal build (Qwen3_5ForConditionalGeneration)
  // loads with its family's causal-LM class, which reads the embedding and
  // decoder only.
  const config = (await (await fetch(`/${dir}/config.json`)).json()) as {
    architectures?: Array<string>
  }
  const arch = config.architectures?.[0] ?? ""
  const Model =
    (arch.endsWith("ForConditionalGeneration") &&
      tf[arch.replace(/ForConditionalGeneration$/, "ForCausalLM")]) ||
    tf.AutoModelForCausalLM
  const t0 = performance.now()
  const model = await Model.from_pretrained(dir, {
    device: "webgpu",
    dtype: "q4f16",
    use_external_data_format: true
  })
  const label = `Transformers.js 4.3.2 WebGPU q4f16 /${dir}/`
  log(`${label} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const int64 = (values: Array<number>) => BigInt64Array.from(values, (v) => BigInt(v))
  const inputs = (ids: Array<number>) => ({
    input_ids: new tf.Tensor("int64", int64(ids), [1, ids.length]),
    attention_mask: new tf.Tensor("int64", int64(ids.map(() => 1)), [1, ids.length])
  })
  return {
    label,
    async first(ids) {
      const out = await model({
        ...inputs(ids),
        num_logits_to_keep: new tf.Tensor("int64", int64([1]), [])
      })
      const logits = asFloat32(out.logits)
      const width = out.logits.dims[2]
      const rows = out.logits.dims[1]
      return logits.slice((rows - 1) * width, rows * width)
    },
    async greedy(ids, _first, steps) {
      const out = await model.generate({
        ...inputs(ids),
        max_new_tokens: steps,
        do_sample: false
      })
      const all = Array.from(out.data as BigInt64Array, Number)
      return all.slice(ids.length)
    }
  }
}

export async function main(params: Params, output: Output) {
  log = output.log
  result = output.result
  refDir = `/ref/${params.set ?? "lfm3"}/`
  const ref = (await (await fetch(`${refDir}tool_prompts.json`)).json()) as Prompts
  const REFS = ref.refs ?? []
  const V = ref.vocab
  const steps = params.steps ?? 48
  const runner = params.runtime === "tjs" ? await tjs(params) : await webgl(params)
  const rows: Array<Record<string, unknown>> = []
  let sumP = 0
  let greedyCalls = 0
  let sameTop = 0
  const klSum = REFS.map(() => 0)
  for (const [i, prompt] of ref.prompts.entries()) {
    const logits = await runner.first(prompt.ids)
    if (logits.length < V) throw new Error(`${logits.length} logits, expected ${V}`)
    const p = softmax(logits, V)[ref.tool_call_id]
    const top = argmax(logits, V)
    const kls: Record<string, number> = {}
    for (const [r, name] of REFS.entries()) {
      const want = await refRow(`logits_${name}.bin`, V, i)
      kls[name] = kl(logits, want, V)
      klSum[r] += kls[name]
      if (r === 0 && top === argmax(want, V)) sameTop++
    }
    sumP += p
    if (top === ref.tool_call_id) greedyCalls++
    const reply = await runner.greedy(prompt.ids, logits, steps, ref.eos_id)
    rows.push({ i, question: prompt.question, p_tool_call: p, top, kl: kls, reply })
    log(
      `#${String(i).padStart(2)} P(<tool_call>) ${p.toFixed(3)}  top ${top === ref.tool_call_id ? "<tool_call>" : top}  KL ${REFS.map((name) => `${name} ${kls[name].toExponential(2)}`).join(", ")}  ${prompt.question}`
    )
  }
  const n = ref.prompts.length
  log(
    `SUMMARY ${runner.label}: mean P(<tool_call> first) ${(sumP / n).toFixed(3)}, greedy ${greedyCalls}/${n}` +
      (REFS.length
        ? `; same top token as ${REFS[0]} ${sameTop}/${n}; mean KL ${REFS.map((name, r) => `vs ${name} ${(klSum[r] / n).toExponential(2)}`).join(", ")}`
        : "")
  )
  result({ page: "tools", runtime: runner.label, params, rows })
}
