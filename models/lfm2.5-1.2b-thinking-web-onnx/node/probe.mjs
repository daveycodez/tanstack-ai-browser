import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [, , dir, build] = process.argv;
ort.env.wasm.numThreads = 1;
const dist = pathToFileURL(`${import.meta.dirname}/node_modules/onnxruntime-web/dist/`).href;
const sfx = build === 'plain' ? '' : '.' + build;
ort.env.wasm.wasmPaths = { mjs: `${dist}ort-wasm-simd-threaded${sfx}.mjs`, wasm: `${dist}ort-wasm-simd-threaded${sfx}.wasm` };
for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('gbq_')).sort()) {
  try {
    const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(`${dir}/${f}`)), { executionProviders: ['wasm'] });
    const o = await s.run({ ids: new ort.Tensor('int64', BigInt64Array.from([1n, 5n, 9n]), [1, 3]) });
    console.log(build, f, 'OK', o.y.dims.join('x'));
  } catch (e) { console.log(build, f, 'FAIL', String(e.message).slice(0, 120)); }
}
process.exit(0);
