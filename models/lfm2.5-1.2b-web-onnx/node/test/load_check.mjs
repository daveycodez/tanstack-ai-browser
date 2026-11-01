// Usage: node load_check.mjs <workdir> <modelDir> <variant: plain|asyncify|jsep|jspi> [threads]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [W, dir, variant = 'plain', th = '1'] = process.argv.slice(2);
const dist = `${W}/node/node_modules/onnxruntime-web/dist/`;
const ort = await import(pathToFileURL(dist + 'ort.node.min.mjs').href);
const base = variant === 'plain' ? 'ort-wasm-simd-threaded' : `ort-wasm-simd-threaded.${variant}`;
ort.env.wasm.numThreads = +th;
ort.env.wasm.wasmPaths = { mjs: pathToFileURL(dist + base + '.mjs').href, wasm: pathToFileURL(dist + base + '.wasm').href };
try {
  const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(`${dir}/model_q4.onnx`)), { executionProviders: ['wasm'], externalData: [{ path: 'model_q4.onnx_data', data: new Uint8Array(readFileSync(`${dir}/model_q4.onnx_data`)) }] });
  console.log(variant, 'SESSION OK', s.inputNames.length, 'inputs');
} catch (e) { console.log(variant, 'FAILED:', String(e.message ?? e).slice(0, 300)); }
process.exit(0);
