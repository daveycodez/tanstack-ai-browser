delete globalThis.Float16Array;
const ort = (await import('onnxruntime-node')).default;
const sess = await ort.InferenceSession.create(process.argv[2], { executionProviders: [process.argv[3]] });
const feed = {};
for (const n of sess.inputNames) {
  if (n.startsWith('past_conv')) feed[n] = new ort.Tensor('float16', new Uint16Array(6 * 2048), [1, 6, 2048]);
  else if (n.startsWith('past_key_values')) feed[n] = new ort.Tensor('float16', new Uint16Array(0), [1, 4, 0, 128]);
}
feed.input_ids = new ort.Tensor('int64', BigInt64Array.from([124894n, 124899n, 5922n]), [1, 3]);
feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from([1n, 1n, 1n]), [1, 3]);
feed.num_logits_to_keep = new ort.Tensor('int64', BigInt64Array.from([1n]), []);
try { const o = await sess.run(feed); console.log('ok', o.logits.dims, o['present_conv.0'].dims, o['present.2.key'].dims); }
catch (e) { console.log('ERR', e.message); }
