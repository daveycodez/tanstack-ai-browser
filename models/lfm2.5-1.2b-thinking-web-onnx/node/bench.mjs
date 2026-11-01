import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
const [, , dir] = process.argv;
ort.env.wasm.numThreads = 1;
for (const f of ['mnb.onnx', 'matmul_f32.onnx']) {
  const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(`${dir}/${f}`)), { executionProviders: ['wasm'] });
  for (const M of [1, 16, 64]) {
    const x = new ort.Tensor('float32', new Float32Array(M * 2048).fill(0.1), [1, M, 2048]);
    await s.run({ x });
    const t0 = performance.now(); for (let i = 0; i < 5; i++) await s.run({ x });
    console.log(f, 'M=' + M, ((performance.now() - t0) / 5).toFixed(1), 'ms');
  }
}
process.exit(0);
