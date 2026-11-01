// Load a model with onnxruntime-web (WebGPU EP, asyncify build) on Dawn in Node, mimicking the app:
// externalData is a lazy stand-in that reads each slice from disk. Reports wasm heap, GPU buffer
// totals, how each external tensor was consumed (0 = copied into wasm heap, 1 = uploaded to GPU).
import fs from 'fs';
import path from 'path';
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
const [modelPath, runSteps] = process.argv.slice(2);
// --- GPU accounting ---
let live = 0, peakLive = 0, created = 0, nBuf = 0, written = 0;
const origReqAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (o) => {
  const ad = await origReqAdapter(o);
  const origReqDev = ad.requestDevice.bind(ad);
  ad.requestDevice = async (d) => {
    const dev = await origReqDev(d);
    const cb = dev.createBuffer.bind(dev);
    dev.createBuffer = (desc) => {
      const b = cb(desc); live += desc.size; created += desc.size; nBuf++; peakLive = Math.max(peakLive, live);
      const des = b.destroy.bind(b); let dead = false;
      b.destroy = () => { if (!dead) { dead = true; live -= desc.size; } return des(); };
      return b;
    };
    const wb = dev.queue.writeBuffer.bind(dev.queue);
    dev.queue.writeBuffer = (buf, off, data, dOff, size) => { written += size ?? (data.byteLength - (dOff ?? 0)); return wb(buf, off, data, dOff, size); };
    return dev;
  };
  return ad;
};
// --- wasm memory capture ---
let mem = null;
const oi = WebAssembly.instantiate;
WebAssembly.instantiate = async (...a) => { const r = await oi(...a); const inst = r.instance ?? r; mem = mem ?? Object.values(inst.exports).find(x => x instanceof WebAssembly.Memory) ?? null; if (!mem) { for (const ns of Object.values(a[1] ?? {})) for (const v of Object.values(ns)) if (v instanceof WebAssembly.Memory) mem = v; } return r; };
const OM = WebAssembly.Memory;
WebAssembly.Memory = function (d) { const m = new OM(d); mem = m; return m; };
WebAssembly.Memory.prototype = OM.prototype;
// --- external data stand-in, as in the app ---
const dataPath = path.join(path.dirname(modelPath), 'model_q4f16.onnx_data');
const fd = fs.openSync(dataPath, 'r'); const size = fs.fstatSync(fd).size;
const view = new Uint8Array(0);
const ext = { 0: [0, 0], 1: [0, 0] }; let maxSlice = 0;
globalThis.__extLog = (off, len, kind) => { ext[kind] ??= [0, 0]; ext[kind][0]++; ext[kind][1] += len; if (kind === 0 && len > 1e6) heapBig.push([off, len]); };
const heapBig = [];
Object.defineProperties(view, {
  byteLength: { get: () => size }, length: { get: () => size },
  subarray: { value: (b = 0, e = size) => { const s = new Uint8Array(e - b); fs.readSync(fd, s, 0, e - b, b); maxSlice = Math.max(maxSlice, e - b); return s; } },
});
const ort = await import('./ortweb/ort.webgpu.mjs');
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./ortweb/', import.meta.url).href;
const rss0 = process.memoryUsage().rss;
const t0 = Date.now();
const GEN = (runSteps ?? '').startsWith('gen:');
const sess = await ort.InferenceSession.create(fs.readFileSync(modelPath), {
  executionProviders: ['webgpu'], graphOptimizationLevel: 'all',
  ...(GEN ? { preferredOutputLocation: 'gpu-buffer' } : {}),
  externalData: [{ path: 'model_q4f16.onnx_data', data: view }],
});
const res = { model: modelPath, createMs: Date.now() - t0, wasmHeapMB: mem ? mem.buffer.byteLength / 1e6 : null,
  gpuLiveMB: live / 1e6, gpuPeakLiveMB: peakLive / 1e6, gpuCreatedMB: created / 1e6, nBuffers: nBuf, writeBufferMB: written / 1e6,
  extToHeap: { n: ext[0][0], MB: ext[0][1] / 1e6 }, extToGpu: { n: ext[1][0], MB: ext[1][1] / 1e6 }, heapBigSlices: heapBig,
  maxSliceMB: maxSlice / 1e6, rssMB: process.memoryUsage().rss / 1e6 };
if (runSteps && !GEN) {
  const feed = {};
  for (const n of sess.inputNames) {
    if (n.startsWith('past_conv')) feed[n] = new ort.Tensor('float16', new Uint16Array(6 * 2048), [1, 6, 2048]);
    else if (n.startsWith('past_key_values')) feed[n] = new ort.Tensor('float16', new Uint16Array(0), [1, 4, 0, 128]);
  }
  const ids = [124894n, 124899n, 5922n, 207n, 2992n];
  feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids), [1, ids.length]);
  feed.attention_mask = new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
  feed.num_logits_to_keep = new ort.Tensor('int64', BigInt64Array.from([1n]), []);
  const o = await sess.run(feed);
  const lg = o.logits.data; let b = 0; for (let i = 1; i < lg.length; i++) if (lg[i] > lg[b]) b = i;
  res.afterRun = { wasmHeapMB: mem.buffer.byteLength / 1e6, gpuLiveMB: live / 1e6, gpuPeakLiveMB: peakLive / 1e6, top1: b };
}
if (GEN) {
  const [, P, D] = runSteps.split(':').map(Number);
  const meta = sess.inputMetadata;
  const dimOf = (d, past) => d === 'batch_size' ? 1 : d === 'past_sequence_length' ? past : d;
  let cache = {};
  for (const mi of meta) if (mi.name.startsWith('past')) { const dims = mi.shape.map(d => dimOf(d, 0)); cache[mi.name] = new ort.Tensor('float16', new Uint16Array(dims.reduce((a, b) => a * b, 1)), dims); }
  const names = sess.inputNames; let total = 0; const t1 = Date.now();
  const step = async (ids) => {
    total += ids.length;
    const feed = { ...cache, input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]) };
    if (names.includes('num_logits_to_keep')) feed.num_logits_to_keep = new ort.Tensor('int64', BigInt64Array.from([1n]), []);
    const o = await sess.run(feed);
    const nc = {}; for (const n of Object.keys(cache)) { nc[n] = o[n.replace('past_key_values', 'present').replace('past_conv', 'present_conv')]; }
    for (const n of Object.keys(cache)) if (cache[n].location === 'gpu-buffer') cache[n].dispose();
    cache = nc; return o.logits;
  };
  const prompt = Array.from({ length: P }, (_, i) => 1000 + (i * 7919) % 20000);
  let lg = await step(prompt); const firstLogits = lg.dims;
  for (let i = 0; i < D; i++) { const d = await lg.getData(true); let b = 0; for (let j = 1; j < d.length; j++) if (d[j] > d[b]) b = j; lg = await step([b]); }
  res.gen = { P, D, ms: Date.now() - t1, gpuLiveMB: live / 1e6, gpuPeakLiveMB: peakLive / 1e6, wasmHeapMB: mem.buffer.byteLength / 1e6 };
}
console.log(JSON.stringify(res));
process.exit(0);
