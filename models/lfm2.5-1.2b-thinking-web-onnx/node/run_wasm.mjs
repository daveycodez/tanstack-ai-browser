// Usage: node run_wasm.mjs <root> <threads> <promptName> <nsteps> [build: default|asyncify|jspi]
import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [, , root, threadsArg, promptName, nstepsArg, build = 'default'] = process.argv;
const threads = Number(threadsArg), nsteps = Number(nstepsArg);
ort.env.wasm.numThreads = threads;
if (build !== 'default') {
  const dist = pathToFileURL(`${import.meta.dirname}/node_modules/onnxruntime-web/dist/`).href;
  ort.env.wasm.wasmPaths = { mjs: `${dist}ort-wasm-simd-threaded${build === "plain" ? "" : "." + build}.mjs`, wasm: `${dist}ort-wasm-simd-threaded${build === "plain" ? "" : "." + build}.wasm` };
}
const py = JSON.parse(fs.readFileSync(`${root}/out/python_results.json`, 'utf8'))[promptName];
const ids = py.prompt_ids;
// Load like a browser: model and external data as in-memory Uint8Arrays.
const model = new Uint8Array(fs.readFileSync(`${root}/out/onnx/model_q4.onnx`));
const data = new Uint8Array(fs.readFileSync(`${root}/out/onnx/model_q4.onnx_data`));
let t0 = performance.now();
const s = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], externalData: [{ path: 'model_q4.onnx_data', data }] });
const loadMs = performance.now() - t0;

const i64 = (arr, dims) => new ort.Tensor('int64', BigInt64Array.from(arr.map(BigInt)), dims);
function emptyPast() {
  const f = {};
  for (const n of s.inputNames) {
    if (n.startsWith('past_conv')) f[n] = new ort.Tensor('float32', new Float32Array(2048 * 3), [1, 2048, 3]);
    else if (n.startsWith('past_key_values')) f[n] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
  }
  return f;
}
function toPast(out) {
  const f = {};
  for (const n of s.outputNames) if (n !== 'logits') f[n.replace('present_conv', 'past_conv').replace('present.', 'past_key_values.')] = out[n];
  return f;
}
async function step(tokIds, past, pastLen) {
  const feeds = { ...past, input_ids: i64(tokIds, [1, tokIds.length]), attention_mask: i64(new Array(pastLen + tokIds.length).fill(1), [1, pastLen + tokIds.length]), num_logits_to_keep: i64([1], []) };
  return s.run(feeds);
}
const argmax = (a) => { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; };
const topk = (a, k) => Array.from(a.keys()).sort((x, y) => a[y] - a[x]).slice(0, k);

t0 = performance.now();
let out = await step(ids, emptyPast(), 0);
const prefillMs = performance.now() - t0;
let logits = out.logits.data;
const logitsDims = out.logits.dims;
const firstTop5 = topk(logits, 5), firstTopVals = firstTop5.map((i) => logits[i]);
const prevPast = toPast(out);
let past = prevPast, L = ids.length;
const toks = [], maxLogits = [];
const stepMs = [];
for (let k = 0; k < nsteps; k++) {
  const t = argmax(logits); toks.push(t); maxLogits.push(logits[t]);
  const ts = performance.now();
  const o = await step([t], past, L); L++;
  stepMs.push(performance.now() - ts);
  // free previous step tensors
  for (const v of Object.values(past)) v.dispose?.();
  past = toPast(o); logits = o.logits.data;
}
const decMs = stepMs.reduce((a, b) => a + b, 0);
const res = { build, threads, promptName, nPrompt: ids.length, loadMs: Math.round(loadMs), prefillMs: Math.round(prefillMs), promptTokPerS: +(ids.length / prefillMs * 1000).toFixed(1), decodeSteps: nsteps, decodeMs: Math.round(decMs), decodeTokPerS: +(nsteps / decMs * 1000).toFixed(2), logitsDims, firstTop5, firstTopVals, pythonTop5: py.top5_after_prompt, tokens: toks, maxLogits, rssMB: Math.round(process.memoryUsage().rss / 1e6) };
fs.writeFileSync(`${root}/out/wasm_${promptName}_${build}_t${threads}.json`, JSON.stringify(res));
const { tokens, maxLogits: _m, ...summary } = res;
console.log(JSON.stringify(summary));
console.log('tokens', JSON.stringify(tokens));
process.exit(0);
