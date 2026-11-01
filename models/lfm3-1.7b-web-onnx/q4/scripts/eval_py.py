import sys, json, time
import numpy as np, onnxruntime as ort
prompts = json.load(open(sys.argv[1]))
models = dict(a.split("=", 1) for a in sys.argv[2:])   # name=path
NSTEPS = 32

def make_session(p):
    so = ort.SessionOptions()
    return ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])

def empty_feeds(s):
    f = {}
    for i in s.get_inputs():
        if i.name.startswith("past"):
            dt = np.float16 if "float16" in i.type else np.float32
            shp = [1 if d == "batch_size" else (0 if isinstance(d, str) else d) for d in i.shape]
            f[i.name] = np.zeros(shp, dt)
    return f

def run_full(s, ids):
    f = empty_feeds(s)
    f["input_ids"] = np.array([ids], np.int64); f["attention_mask"] = np.ones((1, len(ids)), np.int64)
    f["num_logits_to_keep"] = np.array(len(ids), np.int64)
    t = time.time(); out = s.run(["logits"], f)[0][0].astype(np.float32); return out, time.time() - t

def greedy(s, ids, n):
    names = [o.name for o in s.get_outputs()]
    f = empty_feeds(s)
    cur = list(ids); toks = []; logits_hist = []
    inp = ids
    for step in range(n):
        f["input_ids"] = np.array([inp], np.int64); f["attention_mask"] = np.ones((1, len(cur)), np.int64)
        f["num_logits_to_keep"] = np.array(1, np.int64)
        outs = dict(zip(names, s.run(None, f)))
        lg = outs["logits"][0, -1].astype(np.float32); logits_hist.append(lg)
        nt = int(np.argmax(lg)); toks.append(nt); cur.append(nt); inp = [nt]
        for k, v in outs.items():
            if k.startswith("present_conv."): f["past_conv." + k.split(".", 1)[1]] = v
            elif k.startswith("present."): f["past_key_values." + k.split(".", 1)[1]] = v
    return toks, logits_hist

def logsm(x):
    x = x.astype(np.float64); x = x - x.max(-1, keepdims=True); return x - np.log(np.exp(x).sum(-1, keepdims=True))

def compare(ref, tst):
    top1 = float((ref.argmax(-1) == tst.argmax(-1)).mean())
    kls = []
    for i in range(0, len(ref), 256):
        lp, lq = logsm(ref[i:i+256]), logsm(tst[i:i+256])
        kls.append((np.exp(lp) * (lp - lq)).sum(-1))
    kl = np.concatenate(kls)
    return dict(top1=top1, kl_mean=float(kl.mean()), kl_max=float(kl.max()), last_maxabs=float(np.abs(ref[-1] - tst[-1]).max()))

sess = {k: make_session(v) for k, v in models.items()}
names = list(models)
pairs = [(a, b) for a in names for b in names if a < b] if len(names) > 1 else []
results = {}
for pk, pv in prompts.items():
    ids = pv["ids"]
    full = {}; times = {}
    for k, s in sess.items():
        full[k], times[k] = run_full(s, ids)
    gen = {k: greedy(s, ids, NSTEPS) for k, s in sess.items()}
    r = {"len": len(ids), "prefill_s": times, "greedy": {k: g[0] for k, g in gen.items()}, "top5_last": {k: np.argsort(-full[k][-1])[:5].tolist() for k in names}, "pairs": {}}
    for a, b in pairs:
        c = compare(full[a], full[b])
        ga, gb = gen[a][0], gen[b][0]
        same = next((i for i, (x, y) in enumerate(zip(ga, gb)) if x != y), len(ga))
        c["greedy_same_prefix"] = same
        # decode-step logits comparison along the reference's path only while tokens agree
        c["decode_maxabs_while_same"] = float(max(np.abs(x - y).max() for x, y in zip(gen[a][1][:max(same,1)], gen[b][1][:max(same,1)])))
        r["pairs"][f"{a}|{b}"] = c
    results[pk] = r
    print(pk, json.dumps({k: v for k, v in r.items() if k != "greedy"}), flush=True)
    for k in names: print("   ", k, r["greedy"][k])
json.dump(results, open("/dev/stdout" if False else sys.argv[1].replace("prompts.json", "eval_" + "_".join(names) + ".json"), "w"), indent=1)
