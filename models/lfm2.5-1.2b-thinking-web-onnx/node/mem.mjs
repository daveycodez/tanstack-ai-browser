// Measures wasm linear memory while running the multi_turn_tool prompt (1,024 tokens) + 8 decode steps.
const mems = new Set(); const M = WebAssembly.Memory;
WebAssembly.Memory = new Proxy(M, { construct(t, a) { const m = new t(...a); mems.add(m); return m; } });
const wasmMB = () => Math.round([...mems].reduce((s, m) => s + m.buffer.byteLength, 0) / 2 ** 20);
const ort = await import('onnxruntime-web');
const fs = await import('node:fs'); const { pathToFileURL } = await import('node:url');
const [, , root, build] = process.argv;
ort.env.wasm.numThreads = 4;
if (build !== 'plain') { const d = pathToFileURL(`${import.meta.dirname}/node_modules/onnxruntime-web/dist/`).href; ort.env.wasm.wasmPaths = { mjs: `${d}ort-wasm-simd-threaded.${build}.mjs`, wasm: `${d}ort-wasm-simd-threaded.${build}.wasm` }; }
const ids = JSON.parse(fs.readFileSync(`${root}/out/python_results.json`, 'utf8')).multi_turn_tool.prompt_ids;
let data = new Uint8Array(fs.readFileSync(`${root}/out/onnx/model_q4.onnx_data`));
const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(`${root}/out/onnx/model_q4.onnx`)), { executionProviders: ['wasm'], externalData: [{ path: 'model_q4.onnx_data', data }] });
data = null;
console.log('after load: wasm', wasmMB(), 'MB');
const i64 = (a, d) => new ort.Tensor('int64', BigInt64Array.from(a.map(BigInt)), d);
let feeds = {}; for (const n of s.inputNames) { if (n.startsWith('past_conv')) feeds[n] = new ort.Tensor('float32', new Float32Array(6144), [1, 2048, 3]); else if (n.startsWith('past_key')) feeds[n] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]); }
let L = 0, toks = ids;
for (let k = 0; k < 9; k++) {
  const o = await s.run({ ...feeds, input_ids: i64(toks, [1, toks.length]), attention_mask: i64(Array(L + toks.length).fill(1), [1, L + toks.length]), num_logits_to_keep: i64([1], []) });
  L += toks.length; const lg = o.logits.data; let b = 0; for (let i = 1; i < lg.length; i++) if (lg[i] > lg[b]) b = i; toks = [b];
  feeds = {}; for (const n of s.outputNames) if (n !== 'logits') feeds[n.replace('present_conv', 'past_conv').replace('present.', 'past_key_values.')] = o[n];
  if (k === 0) console.log('after 1,024-token prompt: wasm', wasmMB(), 'MB, first token', b);
}
console.log('after 8 decode steps: wasm', wasmMB(), 'MB; rss', Math.round(process.memoryUsage().rss / 2 ** 20), 'MB');
process.exit(0);
