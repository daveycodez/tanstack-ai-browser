import { readFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url';
const [W, th] = process.argv.slice(2); const dist = `${W}/node/node_modules/onnxruntime-web/dist/`;
const ort = await import(pathToFileURL(dist + 'ort.node.min.mjs').href);
ort.env.wasm.numThreads = +th; const base = 'ort-wasm-simd-threaded.asyncify';
ort.env.wasm.wasmPaths = { mjs: pathToFileURL(dist + base + '.mjs').href, wasm: pathToFileURL(dist + base + '.wasm').href };
for (const name of ['nbits', 'fp32']) {
  const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(`${W}/work/bench/${name}.onnx`)), { executionProviders: ['wasm'] });
  const row = { name };
  for (const M of [1, 16, 128]) {
    const x = new ort.Tensor('float32', Float32Array.from({ length: M * 2048 }, () => Math.random()), [M, 2048]);
    await s.run({ x }); const t0 = performance.now(); for (let i = 0; i < 5; i++) await s.run({ x }); row['M' + M + '_ms'] = +((performance.now() - t0) / 5).toFixed(1);
  }
  console.log(JSON.stringify(row));
}
process.exit(0);
