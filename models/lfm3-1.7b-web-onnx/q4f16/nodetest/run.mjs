// usage: node run.mjs <model.onnx> <traj.json> <out.bin> <ep>
// Teacher-forces each trajectory; writes fp16 logits per step (raw uint16), then free-runs greedily.
delete globalThis.Float16Array;
const ort = (await import('onnxruntime-node')).default;
import fs from 'fs';
const [model, trajPath, outBin, ep, eosArg] = process.argv.slice(2); const EOS = Number(eosArg ?? 124900);
const trajs = JSON.parse(fs.readFileSync(trajPath, 'utf8'));
const t0 = Date.now();
const sess = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' });
const tLoad = Date.now() - t0;
const inNames = sess.inputNames;
function emptyCache() {
  const c = {};
  for (const n of inNames) {
    if (n.startsWith('past_conv')) c[n] = new ort.Tensor('float16', new Uint16Array(6 * 2048), [1, 6, 2048]);
    else if (n.startsWith('past_key_values')) c[n] = new ort.Tensor('float16', new Uint16Array(0), [1, 4, 0, 128]);
  }
  return c;
}
async function step(ids, cache, total) {
  const feed = { ...cache,
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
    num_logits_to_keep: new ort.Tensor('int64', BigInt64Array.from([1n]), []) };
  const out = await sess.run(feed);
  const nc = {};
  for (const n of Object.keys(cache)) { const o = out[n.replace('past_key_values', 'present').replace('past_conv', 'present_conv')]; nc[n] = new ort.Tensor(o.type, o.data.slice(), o.dims); }
  return [out.logits.data, nc];
}
function f16(u) { const s = u >> 15, e = (u >> 10) & 31, m = u & 1023; return (s ? -1 : 1) * (e === 0 ? m / 1024 * 2 ** -14 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15)); }
function argmax(u) { let b = 0, bv = -Infinity; for (let i = 0; i < u.length; i++) { const v = f16(u[i]); if (v > bv) { bv = v; b = i; } } return b; }
const fd = fs.openSync(outBin, 'w');
const free = []; let decodeMs = 0, decodeSteps = 0;
for (const t of trajs) {
  let cache = emptyCache(); let total = t.ids.length;
  let [lg, c] = await step(t.ids, cache, total); cache = c;
  fs.writeSync(fd, Buffer.from(lg.buffer, lg.byteOffset, lg.byteLength));
  for (let i = 0; i < t.traj.length - 1; i++) {
    total++; [lg, cache] = await step([t.traj[i]], cache, total);
    fs.writeSync(fd, Buffer.from(lg.buffer, lg.byteOffset, lg.byteLength));
  }
  // free run
  cache = emptyCache(); total = t.ids.length; [lg, cache] = await step(t.ids, cache, total);
  const toks = [];
  for (let i = 0; i < 50; i++) {
    const tk = argmax(lg); toks.push(tk); if (tk === EOS) break;
    total++; const s0 = Date.now(); [lg, cache] = await step([tk], cache, total); decodeMs += Date.now() - s0; decodeSteps++;
  }
  free.push(toks);
}
fs.closeSync(fd);
console.log(JSON.stringify({ model, ep, loadMs: tLoad, msPerDecodeStep: decodeMs / decodeSteps, free }));
