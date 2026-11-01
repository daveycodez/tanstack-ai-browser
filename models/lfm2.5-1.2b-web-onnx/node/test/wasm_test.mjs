// Usage: node wasm_test.mjs <workdir> <numThreads> <bundle: node|webgpu|wasm> <prompt,...>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [W, threadsArg, bundle = 'node', promptArg = 'memo_summary'] = process.argv.slice(2);

// capture wasm memories so we can report the wasm heap size
const memories = [];
const OrigMemory = WebAssembly.Memory;
WebAssembly.Memory = new Proxy(OrigMemory, { construct(t, args) { const m = new t(...args); memories.push(m); return m; } });
const origInst = WebAssembly.instantiate;
WebAssembly.instantiate = async (...a) => { const r = await origInst(...a); const inst = r.instance ?? r; for (const v of Object.values(inst.exports ?? {})) if (v instanceof OrigMemory) memories.push(v); return r; };
const heap = () => Math.max(0, ...memories.map((m) => m.buffer.byteLength));

const dist = `${W}/node/node_modules/onnxruntime-web/dist/`;
const file = { node: 'ort.node.min.mjs', webgpu: 'ort.webgpu.bundle.min.mjs', wasm: 'ort.wasm.bundle.min.mjs' }[bundle];
const ort = await import(pathToFileURL(dist + file).href);
ort.env.wasm.numThreads = Number(threadsArg);
const variant = process.env.VARIANT ?? 'plain';
const base = variant === 'plain' ? 'ort-wasm-simd-threaded' : `ort-wasm-simd-threaded.${variant}`;
ort.env.wasm.wasmPaths = { mjs: pathToFileURL(dist + base + '.mjs').href, wasm: pathToFileURL(dist + base + '.wasm').href };  // local wasm files only
ort.env.logLevel = 'warning';

const modelBytes = new Uint8Array(readFileSync(`${W}/out/onnx/model_q4.onnx`));
const dataBytes = new Uint8Array(readFileSync(`${W}/out/onnx/model_q4.onnx_data`));
const ref = JSON.parse(readFileSync(`${W}/data/python_ref.json`, 'utf8'));

let t0 = performance.now();
const session = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ['wasm'],
  externalData: [{ path: 'model_q4.onnx_data', data: dataBytes }],
});
const loadMs = performance.now() - t0;
const rssAfterLoad = process.memoryUsage().rss;
console.log(JSON.stringify({ bundle, variant, threads: Number(threadsArg), ortVersion: ort.env.versions?.web, loadMs: Math.round(loadMs), wasmHeapMB: Math.round(heap() / 2 ** 20), rssMB: Math.round(rssAfterLoad / 2 ** 20), inputs: session.inputNames.slice(-2), outputs0: session.outputNames[0] }));

function emptyPast() {
  const f = {};
  for (const n of session.inputNames) {
    if (n.startsWith('past_conv.')) f[n] = new ort.Tensor('float32', new Float32Array(2048 * 3), [1, 2048, 3]);
    else if (n.startsWith('past_key_values.')) f[n] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
  }
  return f;
}
async function step(ids, past, total) {
  const feeds = { ...past,
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
    num_logits_to_keep: new ort.Tensor('int64', BigInt64Array.from([1n]), []),
  };
  const out = await session.run(feeds);
  const next = {};
  for (const [k, v] of Object.entries(out)) {
    if (k.startsWith('present_conv.')) next['past_conv.' + k.slice(13)] = v;
    else if (k.startsWith('present.')) next['past_key_values.' + k.slice(8)] = v;
  }
  if (!(out.logits.dims[0] === 1 && out.logits.dims[1] === 1 && out.logits.dims[2] === 65536)) throw new Error('bad logits dims ' + out.logits.dims);
  return { logits: out.logits.data, past: next };
}
const argmax = (a) => { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; };

for (const name of promptArg.split(',')) {
  const r = ref[name]; const T = r.ids.length;
  const res = { prompt: name, T, runs: [] };
  for (let rep = 0; rep < Number(process.env.REPS ?? 1); rep++) {
    t0 = performance.now();
    let { logits, past } = await step(r.ids, emptyPast(), T);
    const prefillMs = performance.now() - t0;
    let maxTopDiff = 0, topIdsMatch = true; const toks = [];
    const cmp = (lg, k) => {
      for (const [id, val] of r.top5[k]) maxTopDiff = Math.max(maxTopDiff, Math.abs(lg[id] - val));
      const order = Array.from(r.top5[k], ([id]) => id); const mine = [...lg.keys()].sort((a, b) => lg[b] - lg[a]).slice(0, 5);
      if (mine[0] !== order[0]) topIdsMatch = false;
      return mine.join(',') === order.join(',');
    };
    let top5OrderSame = 0; if (cmp(logits, 0)) top5OrderSame++;
    t0 = performance.now();
    for (let k = 0; k < 20; k++) {
      const t = argmax(logits); toks.push(t);
      ({ logits, past } = await step([t], past, T + k + 1));
      if (cmp(logits, k + 1)) top5OrderSame++;
    }
    const decodeMs = performance.now() - t0;
    res.runs.push({ prefillMs: Math.round(prefillMs), promptTokPerS: +(T / prefillMs * 1000).toFixed(1), decodeTokPerS: +(20 / decodeMs * 1000).toFixed(2),
      greedySameAsPython: JSON.stringify(toks) === JSON.stringify(r.greedy), top1SameAllSteps: topIdsMatch, top5OrderSameSteps: `${top5OrderSame}/21`, maxAbsDiffTop5Logits: +maxTopDiff.toExponential(3) });
  }
  res.wasmHeapMB = Math.round(heap() / 2 ** 20); res.rssMB = Math.round(process.memoryUsage().rss / 2 ** 20);
  console.log(JSON.stringify(res));
}
await session.release();
process.exit(0);
