// Usage: node test.mjs <model.onnx> <data file> <prompts.json> <promptKey> <numThreads> <steps> <out.json> [build: default|asyncify|jspi]
import fs from "node:fs"
import path from "node:path"
const [modelPath, dataPath, promptsPath, key, threads, steps, outPath, build = "default"] = process.argv.slice(2)
import { pathToFileURL } from "node:url"

// Track wasm memory the way the app's worker does.
const memories = new Set()
const OrigMemory = WebAssembly.Memory
WebAssembly.Memory = new Proxy(OrigMemory, { construct(t, a) { const m = new t(...a); memories.add(m); return m } })
for (const name of ["instantiate", "instantiateStreaming"]) {
  const orig = WebAssembly[name]
  WebAssembly[name] = async function (...args) {
    const r = await orig.apply(this, args)
    const inst = r.instance ?? r
    for (const v of Object.values(inst.exports ?? {})) if (v instanceof OrigMemory) memories.add(v)
    return r
  }
}
const wasmMB = () => { let b = 0; for (const m of memories) b += m.buffer.byteLength; return Math.round(b / 2 ** 20) }

const ort = await import("onnxruntime-web")
ort.env.wasm.numThreads = Number(threads)
if (build !== "default") {
  const dist = path.resolve("node_modules/onnxruntime-web/dist") + "/"
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(dist + `ort-wasm-simd-threaded.${build}.mjs`).href, wasm: pathToFileURL(dist + `ort-wasm-simd-threaded.${build}.wasm`).href }
}
ort.env.logLevel = "warning"
const prompt = JSON.parse(fs.readFileSync(promptsPath, "utf8"))[key].ids

const modelBytes = new Uint8Array(fs.readFileSync(modelPath))
const dataBuf = fs.readFileSync(dataPath)
const data = new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength)
let t0 = performance.now()
const session = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
  externalData: [{ path: path.basename(dataPath), data }],
})
const loadS = (performance.now() - t0) / 1000
const memAfterLoad = wasmMB()

const feeds = {}
for (const name of session.inputNames) {
  if (name.startsWith("past_conv.")) feeds[name] = new ort.Tensor("float32", new Float32Array(6 * 2048), [1, 6, 2048])
  else if (name.startsWith("past_key_values.")) feeds[name] = new ort.Tensor("float32", new Float32Array(0), [1, 4, 0, 128])
}
const big = (arr) => new ort.Tensor("int64", BigInt64Array.from(arr.map(BigInt)), [1, arr.length])
let total = prompt.length
let input = prompt
const tokens = [], top5 = [], logitsDump = [], stepMs = []
for (let step = 0; step < Number(steps) + 1; step++) {
  feeds.input_ids = big(input)
  feeds.attention_mask = big(new Array(total).fill(1))
  feeds.num_logits_to_keep = new ort.Tensor("int64", BigInt64Array.from([1n]), [])
  t0 = performance.now()
  const out = await session.run(feeds)
  stepMs.push(performance.now() - t0)
  const lg = out.logits.data
  const V = lg.length
  const idx = Array.from({ length: V }, (_, i) => i).sort((a, b) => lg[b] - lg[a]).slice(0, 5)
  top5.push(idx); logitsDump.push(Float32Array.from(lg))
  if (step === Number(steps)) break
  const next = idx[0]; tokens.push(next)
  for (const [k, v] of Object.entries(out)) {
    if (k.startsWith("present_conv.")) { feeds["past_conv." + k.slice(13)]?.dispose?.(); feeds["past_conv." + k.slice(13)] = v }
    else if (k.startsWith("present.")) { feeds["past_key_values." + k.slice(8)]?.dispose?.(); feeds["past_key_values." + k.slice(8)] = v }
    else v.dispose?.()
  }
  input = [next]; total += 1
}
const prefillS = stepMs[0] / 1000
const dec = stepMs.slice(1)
const decodeTps = dec.length / (dec.reduce((a, b) => a + b, 0) / 1000)
const res = { key, build, promptLen: prompt.length, threads: Number(threads), loadS, memAfterLoadMB: memAfterLoad, memPeakMB: wasmMB(),
  prefillS, prefillTps: prompt.length / prefillS, decodeTps, decodeMsMedian: dec.slice().sort((a, b) => a - b)[Math.floor(dec.length / 2)],
  tokens, top5 }
fs.writeFileSync(outPath, JSON.stringify(res))
fs.writeFileSync(outPath.replace(/\.json$/, ".logits.bin"), Buffer.concat(logitsDump.map((a) => Buffer.from(a.buffer))))
console.log(JSON.stringify({ ...res, top5: res.top5.slice(0, 2) }))
await session.release()
process.exit(0)
