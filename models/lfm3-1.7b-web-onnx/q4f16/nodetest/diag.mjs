// One-pass prefill diagnostics on onnxruntime-web (Transformers.js 4.3.2's build) + Dawn:
// pipelines created, dispatch sizes, bind sizes, per-submit GPU time, buffer peaks.
// usage: node diag.mjs <model.onnx> <promptLen> <presentNames.json> [decodeSteps]
import fs from 'fs';
import path from 'path';
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
const [modelPath, P_, presentPath, D_] = process.argv.slice(2);
const HIDE = (process.env.HIDE ?? '').split(',').filter(Boolean);
if (HIDE.length) { const orq = gpu.requestAdapter.bind(gpu); gpu.requestAdapter = async (o) => { const ad = await orq(o);
  const feats = new Set([...ad.features].filter(f => !HIDE.includes(f))); Object.defineProperty(ad, 'features', { value: feats });
  const rd = ad.requestDevice.bind(ad); ad.requestDevice = (d) => rd({ ...d, requiredFeatures: (d?.requiredFeatures ?? []).filter(f => !HIDE.includes(f)) }); return ad; }; }
const P = +P_, D = +(D_ ?? 0);
const st = { phase: 'load' }; const ph = {};
const S = (k) => (ph[st.phase] ??= { pipelines: 0, shaderModules: 0, dispatches: 0, maxWG: [0, 0, 0], maxWGTotal: 0, maxBind: 0, submits: 0, submitMs: [], live: 0, peak: 0, maxBuf: 0, created: 0 });
let live = 0;
for (const [cls, name, fn] of [
  [GPUDevice, 'createComputePipeline', (s, a) => s.pipelines++], [GPUDevice, 'createComputePipelineAsync', (s, a) => s.pipelines++],
  [GPUDevice, 'createShaderModule', (s, a) => s.shaderModules++],
  [GPUDevice, 'createBindGroup', (s, a) => { for (const e of a[0].entries ?? []) { const r = e.resource; if (r && r.buffer) { const sz = r.size ?? r.buffer.size - (r.offset ?? 0); s.maxBind = Math.max(s.maxBind, sz); } } }],
  [GPUComputePassEncoder, 'dispatchWorkgroups', (s, a) => { s.dispatches++; const w = [a[0] ?? 1, a[1] ?? 1, a[2] ?? 1]; for (let i = 0; i < 3; i++) s.maxWG[i] = Math.max(s.maxWG[i], w[i]); s.maxWGTotal = Math.max(s.maxWGTotal, w[0] * w[1] * w[2]); }],
]) { const o = cls.prototype[name]; cls.prototype[name] = function (...a) { fn(S(), a); return o.apply(this, a); }; }
const oc = GPUDevice.prototype.createBuffer;
GPUDevice.prototype.createBuffer = function (desc) {
  const b = oc.call(this, desc); const s = S(); live += desc.size; s.created += desc.size; s.peak = Math.max(s.peak, live); s.maxBuf = Math.max(s.maxBuf, desc.size);
  const od = b.destroy.bind(b); let dead = false; b.destroy = () => { if (!dead) { dead = true; live -= desc.size; } return od(); }; return b;
};
let lastDone = 0;
const os = GPUQueue.prototype.submit;
GPUQueue.prototype.submit = function (cmds) {
  const s = S(); s.submits++; const t = performance.now(); const r = os.call(this, cmds);
  this.onSubmittedWorkDone().then(() => { const now = performance.now(); s.submitMs.push(now - Math.max(t, lastDone)); lastDone = now; });
  return r;
};
const fd = fs.openSync(path.join(path.dirname(modelPath), 'model_q4f16.onnx_data'), 'r'); const size = fs.fstatSync(fd).size;
const view = new Uint8Array(0);
Object.defineProperties(view, { byteLength: { get: () => size }, length: { get: () => size },
  subarray: { value: (b = 0, e = size) => { const s = new Uint8Array(e - b); fs.readSync(fd, s, 0, e - b, b); return s; } } });
const ORTDIR = process.env.ORTDIR ?? 'ortweb_dev';
const ort = await import('./' + ORTDIR + '/ort.webgpu.mjs');
ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = new URL('./' + ORTDIR + '/', import.meta.url).href; ort.env.webgpu.powerPreference = 'high-performance';
const outNames = JSON.parse(fs.readFileSync(presentPath, 'utf8'));
const sess = await ort.InferenceSession.create(fs.readFileSync(modelPath), { executionProviders: ['webgpu'],
  externalData: [{ path: 'model_q4f16.onnx_data', data: view }], preferredOutputLocation: Object.fromEntries(outNames.map(n => [n, 'gpu-buffer'])) });
const base = live;
let cache = {};
for (const mi of sess.inputMetadata) if (mi.name.startsWith('past')) { const dims = mi.shape.map(d => d === 'batch_size' ? 1 : (typeof d === 'number' ? d : 0)); cache[mi.name] = new ort.Tensor('float16', new Uint16Array(dims.reduce((a, b) => a * b, 1)), dims); }
let total = 0; const names = sess.inputNames;
const step = async (ids) => { total += ids.length;
  const feed = { ...cache, input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]), attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]) };
  if (names.includes('num_logits_to_keep')) feed.num_logits_to_keep = new ort.Tensor('int64', BigInt64Array.from([1n]), []);
  const o = await sess.run(feed); const nc = {}; for (const n of Object.keys(cache)) nc[n] = o[n.replace('past_key_values', 'present').replace('past_conv', 'present_conv')];
  for (const n of Object.keys(cache)) if (cache[n].location === 'gpu-buffer') cache[n].dispose(); cache = nc; return o.logits; };
const ids = []; let x = 12345; for (let i = 0; i < P; i++) { x = (x * 1103515245 + 12345) % 2147483648; ids.push(1000 + (x % 30000)); }
// warm-up run with a different short prompt first (as the app does a short prompt first), then the measured prefill
st.phase = 'warm16'; await (await step(ids.slice(0, 16))).getData();
for (const n of Object.keys(cache)) if (cache[n].location === 'gpu-buffer') cache[n].dispose();
cache = {}; for (const mi of sess.inputMetadata) if (mi.name.startsWith('past')) { const dims = mi.shape.map(d => d === 'batch_size' ? 1 : (typeof d === 'number' ? d : 0)); cache[mi.name] = new ort.Tensor('float16', new Uint16Array(dims.reduce((a, b) => a * b, 1)), dims); }
total = 0; lastDone = 0;
st.phase = 'prefill'; const t0 = performance.now(); let lg = await step(ids); await lg.getData(); const prefillMs = performance.now() - t0;
st.phase = 'decode'; for (let i = 0; i < D; i++) { const d = await lg.getData(); let b = 0; for (let j = 1; j < d.length; j++) if (d[j] > d[b]) b = j; lg = await step([b]); } if (D) await lg.getData();
await new Promise(r => setTimeout(r, 300));
const out = { P, prefillMs: Math.round(prefillMs), weightsMB: +(base / 1e6).toFixed(1) };
for (const [k, s] of Object.entries(ph)) { if (k === 'load') continue; const sm = s.submitMs.sort((a, b) => b - a);
  out[k] = { pipelinesNew: s.pipelines, shaderModulesNew: s.shaderModules, dispatches: s.dispatches, submits: s.submits, dispatchesPerSubmit: +(s.dispatches / Math.max(1, s.submits)).toFixed(1),
    maxWorkgroups: s.maxWG, maxWorkgroupsTotal: s.maxWGTotal, maxBindingMB: +(s.maxBind / 1e6).toFixed(2), maxBufferMB: +(s.maxBuf / 1e6).toFixed(2),
    peakAboveWeightsMB: +((s.peak - base) / 1e6).toFixed(1), longestSubmitsMs: sm.slice(0, 3).map(v => +v.toFixed(1)), sumSubmitMs: +sm.reduce((a, b) => a + b, 0).toFixed(0) }; }
out.features = globalThis.__feats; console.log(JSON.stringify(out));
process.exit(0);
