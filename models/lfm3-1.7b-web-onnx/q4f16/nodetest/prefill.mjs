// Prefill memory probe: onnxruntime-web 1.31.1 (asyncify / native WebGPU EP) on Dawn, set up like Transformers.js 4.3.2:
// present.* / present_conv.* stay on GPU ('gpu-buffer'), num_logits_to_keep = 1, weights via a lazy externalData stand-in.
// usage: node prefill.mjs <model.onnx> <promptLen> <chunk|0> <cacheMode|default> <logitsOut> [decodeSteps]
import fs from 'fs';
import path from 'path';
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
const [modelPath, P_, C_, mode, logitsOut, D_] = process.argv.slice(2);
const P = +P_, C = +C_ || P, D = +(D_ ?? 4);
let live = 0, peak = 0, phase = 'load'; const phasePeak = {}; let biggest = { size: 0 }; const sizes = new Map();
const origReq = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (o) => {
  const ad = await origReq(o); const rd = ad.requestDevice.bind(ad);
  ad.requestDevice = async (d) => {
    const dev = await rd(d); const cb = dev.createBuffer.bind(dev);
    dev.createBuffer = (desc) => {
      const b = cb(desc); live += desc.size; peak = Math.max(peak, live); phasePeak[phase] = Math.max(phasePeak[phase] ?? 0, live);
      if (phase !== 'load') { sizes.set(desc.size, (sizes.get(desc.size) ?? 0) + 1); if (desc.size > biggest.size) biggest = { size: desc.size, phase, usage: desc.usage }; }
      const des = b.destroy.bind(b); let dead = false;
      b.destroy = () => { if (!dead) { dead = true; live -= desc.size; } return des(); };
      return b;
    };
    return dev;
  };
  return ad;
};
let mem = null;
const oi = WebAssembly.instantiate;
WebAssembly.instantiate = async (...a) => { const r = await oi(...a); const inst = r.instance ?? r; mem = mem ?? Object.values(inst.exports).find(x => x instanceof WebAssembly.Memory) ?? null; if (!mem) for (const ns of Object.values(a[1] ?? {})) for (const v of Object.values(ns)) if (v instanceof WebAssembly.Memory) mem = v; return r; };
const OM = WebAssembly.Memory; WebAssembly.Memory = function (d) { const m = new OM(d); mem = m; return m; }; WebAssembly.Memory.prototype = OM.prototype;
const fd = fs.openSync(path.join(path.dirname(modelPath), 'model_q4f16.onnx_data'), 'r'); const size = fs.fstatSync(fd).size;
const view = new Uint8Array(0);
Object.defineProperties(view, { byteLength: { get: () => size }, length: { get: () => size },
  subarray: { value: (b = 0, e = size) => { const s = new Uint8Array(e - b); fs.readSync(fd, s, 0, e - b, b); return s; } } });
const ORTDIR = process.env.ORTDIR ?? 'ortweb'; const ort = await import('./' + ORTDIR + '/ort.webgpu.mjs');
ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = new URL('./' + ORTDIR + '/', import.meta.url).href;
ort.env.webgpu.powerPreference = 'high-performance';
const ep = mode === 'default' ? 'webgpu' : { name: 'webgpu', storageBufferCacheMode: mode };
const model = fs.readFileSync(modelPath);
// output names: present* -> gpu-buffer (as Transformers.js does)
const outNames = JSON.parse(fs.readFileSync(process.env.PRESENT_NAMES, 'utf8'));
const sess = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all',
  externalData: [{ path: 'model_q4f16.onnx_data', data: view }],
  preferredOutputLocation: Object.fromEntries((outNames ?? []).filter(n => n.startsWith('present')).map(n => [n, 'gpu-buffer'])) });
const afterLoad = live;
const meta = sess.inputMetadata;
let cache = {};
for (const mi of meta) if (mi.name.startsWith('past')) {
  const dims = mi.shape.map(d => d === 'batch_size' ? 1 : (typeof d === 'number' ? d : 0));
  cache[mi.name] = new ort.Tensor('float16', new Uint16Array(dims.reduce((a, b) => a * b, 1)), dims);
}
let total = 0;
const step = async (ids) => {
  total += ids.length;
  const feed = { ...cache, input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
    num_logits_to_keep: new ort.Tensor('int64', BigInt64Array.from([1n]), []) };
  const o = await sess.run(feed);
  const nc = {}; for (const n of Object.keys(cache)) nc[n] = o[n.replace('past_key_values', 'present').replace('past_conv', 'present_conv')];
  for (const n of Object.keys(cache)) if (cache[n].location === 'gpu-buffer') cache[n].dispose();
  cache = nc; return o.logits;
};
// deterministic "prompt": token ids from a fixed LCG in the regular-vocab range
const ids = []; let x = 12345; for (let i = 0; i < P; i++) { x = (x * 1103515245 + 12345) % 2147483648; ids.push(1000 + (x % 30000)); }
const t0 = Date.now(); phase = 'prefill'; const chunkPeaks = [];
let lg;
for (let s = 0; s < P; s += C) { const before = live; lg = await step(ids.slice(s, s + C)); chunkPeaks.push(+(((phasePeak.prefill ?? 0) - afterLoad) / 1e6).toFixed(1)); }
const prefillMs = Date.now() - t0;
const first = await lg.getData(); fs.writeFileSync(logitsOut, Buffer.from(first.buffer, first.byteOffset, first.byteLength));
const afterPrefill = live;
phase = 'decode'; const td = Date.now();
for (let i = 0; i < D; i++) { const d = await lg.getData(); let b = 0; for (let j = 1; j < d.length; j++) if (d[j] > d[b]) b = j; lg = await step([b]); }
const topSizes = [...sizes.entries()].sort((a, b) => b[0] * b[1] - a[0] * a[1]).slice(0, 6).map(([s, n]) => `${(s / 1e6).toFixed(1)}MBx${n}`);
console.log(JSON.stringify({ P, chunk: C, mode, kvOnGpu: Object.values(cache).every(t => t.location === 'gpu-buffer'), weightsGpuMB: +(afterLoad / 1e6).toFixed(1),
  prefillPeakAboveWeightsMB: +(((phasePeak.prefill ?? afterLoad) - afterLoad) / 1e6).toFixed(1),
  liveAfterPrefillAboveWeightsMB: +((afterPrefill - afterLoad) / 1e6).toFixed(1),
  decodePeakAboveWeightsMB: +(((phasePeak.decode ?? afterLoad) - afterLoad) / 1e6).toFixed(1),
  biggestBufferMB: +(biggest.size / 1e6).toFixed(1), biggestPhase: biggest.phase, wasmHeapMB: mem ? mem.buffer.byteLength / 1e6 : null,
  prefillMs, decodeMsPerTok: +((Date.now() - td) / D).toFixed(1), topAllocs: topSizes }));
process.exit(0);
