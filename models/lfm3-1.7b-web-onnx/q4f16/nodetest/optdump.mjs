delete globalThis.Float16Array;
const ort = (await import('onnxruntime-node')).default;
const [model, out, ep] = process.argv.slice(2);
await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all', optimizedModelFilePath: out });
console.log('ok');
