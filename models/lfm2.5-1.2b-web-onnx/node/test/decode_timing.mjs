// Usage: node decode_timing.mjs <workdir> <threads> <ours|liquid> [bundle] [steps]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [W, th, which, bundle = 'node', stepsArg = '5'] = process.argv.slice(2);
const dist = `${W}/node/node_modules/onnxruntime-web/dist/`;
const ort = await import(pathToFileURL(dist + { node: 'ort.node.min.mjs', webgpu: 'ort.webgpu.bundle.min.mjs' }[bundle]).href);
ort.env.wasm.numThreads = Number(th); ort.env.wasm.wasmPaths = pathToFileURL(dist).href;
const dir = which === 'ours' ? `${W}/out/onnx` : `${W}/dl/liquid/onnx`;
const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(`${dir}/model_q4.onnx`)), { executionProviders: ['wasm'], externalData: [{ path: 'model_q4.onnx_data', data: new Uint8Array(readFileSync(`${dir}/model_q4.onnx_data`)) }] });
const hasKeep = s.inputNames.includes('num_logits_to_keep');
let past = {};
for (const n of s.inputNames) { if (n.startsWith('past_conv.')) past[n] = new ort.Tensor('float32', new Float32Array(6144), [1, 2048, 3]); else if (n.startsWith('past_key_values.')) past[n] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]); }
const ids = JSON.parse(readFileSync(`${W}/data/prompts.json`, 'utf8')).short.ids;
const times = []; let tok = ids, total = ids.length; const outToks = [];
for (let k = 0; k <= Number(stepsArg); k++) {
  const f = { ...past, input_ids: new ort.Tensor('int64', BigInt64Array.from(tok.map(BigInt)), [1, tok.length]), attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]) };
  if (hasKeep) f.num_logits_to_keep = new ort.Tensor('int64', BigInt64Array.from([1n]), []);
  const t0 = performance.now(); const o = await s.run(f); times.push(performance.now() - t0);
  const L = o.logits.data, V = 65536, off = L.length - V; let b = 0; for (let i = 1; i < V; i++) if (L[off + i] > L[off + b]) b = i;
  outToks.push(b);
  past = {}; for (const [k2, v] of Object.entries(o)) { if (k2.startsWith('present_conv.')) past['past_conv.' + k2.slice(13)] = v; else if (k2.startsWith('present.')) past['past_key_values.' + k2.slice(8)] = v; }
  tok = [b]; total++;
}
const dec = times.slice(1);
console.log(JSON.stringify({ which, bundle, threads: +th, prefill21Ms: Math.round(times[0]), decodeMsPerStep: dec.map(Math.round), decodeTokPerS: +(dec.length / dec.reduce((a, b) => a + b, 0) * 1000).toFixed(2), toks: outToks }));
process.exit(0);
