delete globalThis.Float16Array;
const ort = (await import('onnxruntime-node')).default;
import fs from 'fs';
const dir = process.argv[2];
for (const [bits, bs] of [[2, 64], [4, 256], [4, 128]]) {
  const s = await ort.InferenceSession.create(`${dir}/mm_${bits}_${bs}.onnx`, { executionProviders: ['webgpu'] });
  const fb = fs.readFileSync(`${dir}/x_${bits}_${bs}.bin`); const x = new Uint16Array(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength));
  const y = (await s.run({ x: new ort.Tensor('float16', x, [3, 512]) })).y.data;
  fs.writeFileSync(`${dir}/wg_${bits}_${bs}.bin`, Buffer.from(y.buffer, y.byteOffset, y.byteLength));
}
console.log('ok');
