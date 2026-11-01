"""Run the fp16 model on calibration sequences and accumulate H = X^T X for the
input of every weight MatMul (and lm_head). Saves <outdir>/<sanitized input name>.npy
plus map.json: {fp16 weight name -> H file}."""
import sys, os, json, numpy as np, onnx, onnxruntime as ort
from onnx import helper, TensorProto
fp16cpu, calib, outdir = sys.argv[1:4]
os.makedirs(outdir, exist_ok=True)
m = onnx.load(fp16cpu, load_external_data=False)
inits = {t.name for t in m.graph.initializer}
wmap = {}; xs = []
for n in m.graph.node:
    if n.op_type == 'MatMul' and n.input[1] in inits:
        wmap[n.input[1]] = n.input[0]
        if n.input[0] not in xs: xs.append(n.input[0])
    if n.op_type == 'MatMul' and 'lm_head' in n.name: print('lm_head node', n.name, list(n.input))
existing_out = {o.name for o in m.graph.output}
for x in xs:
    if x not in existing_out:
        m.graph.output.append(helper.make_tensor_value_info(x, TensorProto.FLOAT16, None))
tmp = os.path.join(os.path.dirname(fp16cpu), '_collect_tmp.onnx')
onnx.save(m, tmp)
so = ort.SessionOptions(); so.intra_op_num_threads = 24; so.log_severity_level = 3
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
s = ort.InferenceSession(tmp, so, providers=['CPUExecutionProvider'])
ins = {i.name for i in s.get_inputs()}
H = {x: None for x in xs}; ntok = 0
seqs = json.load(open(calib))
for k, ids in enumerate(seqs):
    feed = {'input_ids': np.array([ids], np.int64), 'attention_mask': np.ones((1, len(ids)), np.int64)}
    if 'num_logits_to_keep' in ins: feed['num_logits_to_keep'] = np.array(1, np.int64)
    for i in ins:
        if i.startswith('past_conv'): feed[i] = np.zeros((1, 6, 2048), np.float16)
        elif i.startswith('past_key_values'): feed[i] = np.zeros((1, 4, 0, 128), np.float16)
    outs = s.run(xs, feed)
    for x, a in zip(xs, outs):
        X = a.reshape(-1, a.shape[-1]).astype(np.float32)
        h = X.T @ X
        H[x] = h if H[x] is None else H[x] + h
    ntok += len(ids)
    if k % 10 == 0: print(k, ntok, flush=True)
files = {}
for x, h in H.items():
    f = x.strip('/').replace('/', '_') + '.npy'
    np.save(os.path.join(outdir, f), (h / ntok).astype(np.float32)); files[x] = f
json.dump({w: files[x] for w, x in wmap.items()}, open(os.path.join(outdir, 'map.json'), 'w'), indent=0)
os.remove(tmp)
print('done', len(xs), 'inputs', ntok, 'tokens')
