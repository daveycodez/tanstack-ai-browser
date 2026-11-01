import sys, os, json, time, numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompts import conversations
from transformers import AutoTokenizer

ROOT = sys.argv[1]
LIQ_Q4 = f"{ROOT}/dl/liquid/onnx/model_q4.onnx"
NEW_Q4 = f"{ROOT}/out/onnx/model_q4.onnx"
OUR_Q4F16 = f"{ROOT}/dl/ours/onnx/model_q4f16.onnx"
tok = AutoTokenizer.from_pretrained(f"{ROOT}/dl/ours")
NSTEPS = 16

def sess(p):
    so = ort.SessionOptions()
    return ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])

def empty_past(s, dtype):
    feeds = {}
    for i in s.get_inputs():
        if i.name.startswith("past_conv"):
            feeds[i.name] = np.zeros((1, 2048, 3), dtype=dtype)
        elif i.name.startswith("past_key_values"):
            feeds[i.name] = np.zeros((1, 8, 0, 64), dtype=dtype)
    return feeds

def present_to_past(names, outs):
    d = {}
    for n, v in zip(names, outs):
        if n == "logits": continue
        d[n.replace("present_conv", "past_conv").replace("present.", "past_key_values.")] = v
    return d

def run(s, ids, past, past_len, nltk=None):
    feeds = dict(past)
    feeds["input_ids"] = np.array([ids], dtype=np.int64)
    feeds["attention_mask"] = np.ones((1, past_len + len(ids)), dtype=np.int64)
    if nltk is not None:
        feeds["num_logits_to_keep"] = np.array(nltk, dtype=np.int64)
    names = [o.name for o in s.get_outputs()]
    outs = s.run(names, feeds)
    return names, outs

def greedy(s, ids, dtype, nltk, nsteps):
    names, outs = run(s, ids, empty_past(s, dtype), 0, nltk)
    logits_rows = [outs[0][0, -1].astype(np.float32)]
    past = present_to_past(names, outs); L = len(ids)
    toks = []
    for _ in range(nsteps):
        t = int(np.argmax(logits_rows[-1])); toks.append(t)
        names, outs = run(s, [t], past, L, nltk); L += 1
        past = present_to_past(names, outs)
        logits_rows.append(outs[0][0, -1].astype(np.float32))
    return toks, logits_rows

liq, new, f16 = sess(LIQ_Q4), sess(NEW_Q4), sess(OUR_Q4F16)
print("new q4 inputs:", [(i.name, i.type) for i in new.get_inputs()][-2:], "outputs[0]:", new.get_outputs()[0])
results = {}
for name, msgs, tools in conversations():
    text = tok.apply_chat_template(msgs, tools=tools, add_generation_prompt=True, tokenize=False)
    ids = tok(text, add_special_tokens=False)["input_ids"]
    assert ids[0] == tok.bos_token_id and text.count("<|startoftext|>") == 1, text[:40]
    r = {"n_tokens": len(ids)}
    # 1. full logits + caches: Liquid unmodified vs new with nltk=0
    t0 = time.time(); n_a, o_a = run(liq, ids, empty_past(liq, np.float32), 0); r["liq_prompt_ms"] = round((time.time()-t0)*1000)
    t0 = time.time(); n_b, o_b = run(new, ids, empty_past(new, np.float32), 0, 0); r["new0_prompt_ms"] = round((time.time()-t0)*1000)
    assert n_a == n_b
    r["nltk0_logits_shape"] = list(o_b[0].shape)
    r["nltk0_logits_maxabs"] = float(np.max(np.abs(o_a[0] - o_b[0])))
    r["nltk0_logits_bitexact"] = bool(np.array_equal(o_a[0], o_b[0]))
    r["nltk0_caches_bitexact"] = all(np.array_equal(x, y) for x, y in zip(o_a[1:], o_b[1:]))
    # 2. nltk=1
    t0 = time.time(); n_c, o_c = run(new, ids, empty_past(new, np.float32), 0, 1); r["new1_prompt_ms"] = round((time.time()-t0)*1000)
    r["nltk1_logits_shape"] = list(o_c[0].shape)
    r["nltk1_vs_lastrow_maxabs"] = float(np.max(np.abs(o_c[0][0, -1] - o_a[0][0, -1])))
    r["nltk1_vs_lastrow_bitexact"] = bool(np.array_equal(o_c[0][0, -1], o_a[0][0, -1]))
    r["nltk1_caches_bitexact"] = all(np.array_equal(x, y) for x, y in zip(o_a[1:], o_c[1:]))
    r["logits_absmax"] = float(np.max(np.abs(o_a[0][0, -1])))
    # nltk=3 sanity: last 3 rows
    _, o_d = run(new, ids, empty_past(new, np.float32), 0, 3)
    r["nltk3_shape"] = list(o_d[0].shape); r["nltk3_vs_last3_maxabs"] = float(np.max(np.abs(o_d[0][0] - o_a[0][0, -3:])))
    # 3. greedy decode
    ta, la = greedy(liq, ids, np.float32, None, NSTEPS)
    tb, lb = greedy(new, ids, np.float32, 1, NSTEPS)
    r["greedy_tokens_identical"] = ta == tb
    r["greedy_logits_maxabs"] = float(max(np.max(np.abs(x - y)) for x, y in zip(la, lb)))
    r["greedy_text"] = tok.decode(tb)
    r["greedy_tokens"] = tb
    # 4. our q4f16 on CPU
    tc, lc = greedy(f16, ids, np.float16, 1, NSTEPS)
    r["q4f16_first_top1_same"] = int(np.argmax(lc[0])) == int(np.argmax(lb[0]))
    r["q4f16_first_maxabs"] = float(np.max(np.abs(lc[0] - lb[0])))
    r["q4f16_greedy_tokens_same_prefix"] = next((i for i, (x, y) in enumerate(zip(tb, tc)) if x != y), NSTEPS)
    r["q4f16_greedy_text"] = tok.decode(tc)
    # teacher-forced top-1 agreement of q4f16 along the q4 greedy path
    n_f, o_f = run(f16, ids + tb[:-1], empty_past(f16, np.float16), 0, 0)
    n_g, o_g = run(new, ids + tb[:-1], empty_past(new, np.float32), 0, 0)
    seg_f = o_f[0][0, len(ids)-1:].astype(np.float32); seg_g = o_g[0][0, len(ids)-1:]
    r["q4f16_teacher_forced_top1_agree"] = f"{int(np.sum(seg_f.argmax(-1) == seg_g.argmax(-1)))}/{seg_f.shape[0]}"
    r["q4f16_teacher_forced_maxabs"] = float(np.max(np.abs(seg_f - seg_g)))
    results[name] = r
    print(name, json.dumps({k: v for k, v in r.items() if k != "greedy_tokens"}, ensure_ascii=False), flush=True)
    results[name]["prompt_ids"] = ids
    results[name]["top5_after_prompt"] = [int(x) for x in np.argsort(-la[0])[:5]]
    results[name]["liq_greedy_logits_top"] = [[int(np.argmax(x)), float(np.max(x))] for x in la]
json.dump(results, open(f"{ROOT}/out/python_results.json", "w"), ensure_ascii=False)
