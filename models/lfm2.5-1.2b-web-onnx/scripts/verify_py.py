import json, sys, time
import numpy as np, onnxruntime as ort
W = sys.argv[1]
THREADS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
STEPS = 16
prompts = json.load(open(f'{W}/data/prompts.json'))

def sess(path):
    so = ort.SessionOptions(); so.intra_op_num_threads = THREADS; so.inter_op_num_threads = 1
    return ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])

def empty_feeds(s, ids, past_len=0):
    f = {}
    for i in s.get_inputs():
        if i.name.startswith('past_'):
            dt = np.float16 if i.type == 'tensor(float16)' else np.float32
            shp = [1, 2048, 3] if 'conv' in i.name else [1, 8, 0, 64]
            f[i.name] = np.zeros(shp, dt)
    return f

def run(s, ids, past=None, total=None, keep=None):
    names = [i.name for i in s.get_inputs()]
    f = empty_feeds(s, ids) if past is None else dict(past)
    f['input_ids'] = np.array([ids], np.int64)
    f['attention_mask'] = np.ones((1, total), np.int64)
    if keep is not None:
        assert 'num_logits_to_keep' in names
        f['num_logits_to_keep'] = np.array(keep, np.int64)
    outs = s.run(None, f)
    on = [o.name for o in s.get_outputs()]
    d = dict(zip(on, outs))
    nxt = {('past_conv.' + k[len('present_conv.'):]) if k.startswith('present_conv.') else
           ('past_key_values.' + k[len('present.'):]): v for k, v in d.items() if k != 'logits'}
    return d['logits'], nxt, d

def maxdiff(a, b): return float(np.max(np.abs(a.astype(np.float64) - b.astype(np.float64))))

def greedy(s, first_logits, past, T, keep):
    toks, rows = [], []
    lg = first_logits
    for k in range(STEPS):
        t = int(np.argmax(lg)); toks.append(t)
        logits, past, _ = run(s, [t], past, T + k + 1, keep)
        lg = logits[0, -1]; rows.append(lg)
    return toks, np.stack(rows)

liq = sess(f'{W}/dl/liquid/onnx/model_q4.onnx')
our = sess(f'{W}/out/onnx/model_q4.onnx')
web = sess(f'{W}/dl/web/onnx/model_q4f16.onnx')
print('ours inputs:', [(i.name, i.type, i.shape) for i in our.get_inputs()][-2:], 'logits:', our.get_outputs()[0].shape)

ref_export = {}
summary = []
for name, p in prompts.items():
    ids = p['ids']; T = len(ids)
    t0 = time.time(); L, Lpast, Lraw = run(liq, ids, None, T); tl = time.time() - t0
    L2, _, _ = run(liq, ids, None, T)
    det = maxdiff(L, L2)
    O0, O0past, O0raw = run(our, ids, None, T, keep=0)
    t0 = time.time(); O1, O1past, O1raw = run(our, ids, None, T, keep=1); to1 = time.time() - t0
    O3, _, _ = run(our, ids, None, T, keep=3)
    assert O0.shape == L.shape == (1, T, 65536) and O1.shape == (1, 1, 65536) and O3.shape == (1, 3, 65536)
    cache0 = max(maxdiff(Lraw[k], O0raw[k]) for k in Lraw if k != 'logits')
    cache1 = max(maxdiff(Lraw[k], O1raw[k]) for k in Lraw if k != 'logits')
    r = dict(prompt=name, T=T,
             liquid_run_to_run=det,
             keep0_all_pos_maxdiff=maxdiff(L, O0), keep0_bitexact=bool(np.array_equal(L, O0)),
             keep1_last_maxdiff=maxdiff(L[0, -1], O1[0, 0]), keep1_bitexact=bool(np.array_equal(L[0, -1], O1[0, 0])),
             keep3_maxdiff=maxdiff(L[0, -3:], O3[0]),
             cache_maxdiff_keep0=cache0, cache_maxdiff_keep1=cache1,
             liq_prefill_s=round(tl, 3), our_keep1_prefill_s=round(to1, 3))
    # greedy decode
    lt, lrows = greedy(liq, L[0, -1], Lpast, T, None)
    ot, orows = greedy(our, O1[0, 0], O1past, T, 1)
    r['decode_tokens_equal'] = lt == ot
    r['decode_logits_maxdiff'] = maxdiff(lrows, orows)
    # web q4f16 comparison (float16 caches)
    W1, Wpast, _ = run(web, ids, None, T, keep=1)
    wl = W1[0, 0].astype(np.float32)
    r['q4f16_top1_same'] = int(np.argmax(wl)) == int(np.argmax(O1[0, 0]))
    r['q4f16_last_maxdiff'] = maxdiff(wl, O1[0, 0])
    r['q4f16_logit_range'] = [float(O1[0, 0].min()), float(O1[0, 0].max())]
    wt, wrows = greedy(web, W1[0, 0], Wpast, T, 1)
    r['q4f16_decode_tokens_agree'] = f'{sum(a == b for a, b in zip(wt, ot))}/{STEPS}'
    r['q4f16_first_divergence'] = next((i for i, (a, b) in enumerate(zip(wt, ot)) if a != b), None)
    r['our_tokens'] = ot
    summary.append(r)
    print(json.dumps(r))
    if name in ('memo_summary', 'tools'):
        # reference for the Node/WASM test: prefill top-5 and 20 greedy steps with top-5 per step
        toks, tops, past, lg = [], [], O1past, O1[0, 0]
        def top5(v): idx = np.argsort(-v)[:5]; return [[int(i), float(v[i])] for i in idx]
        tops.append(top5(lg))
        for k in range(20):
            t = int(np.argmax(lg)); toks.append(t)
            logits, past, _ = run(our, [t], past, T + k + 1, 1)
            lg = logits[0, -1]; tops.append(top5(lg))
        ref_export[name] = dict(ids=ids, greedy=toks, top5=tops)
json.dump(ref_export, open(f'{W}/data/python_ref.json', 'w'))
json.dump(summary, open(f'{W}/data/verify_py_summary.json', 'w'), indent=1)
