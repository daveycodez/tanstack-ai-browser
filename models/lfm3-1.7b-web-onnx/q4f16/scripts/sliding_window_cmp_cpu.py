import sys, json, numpy as np
sys.path.insert(0, sys.argv[1])
from lm import LM, load_tok
import lm as L
d = sys.argv[2]; cpu = sys.argv[3]
tok, render = load_tok(d)
saved = json.load(open(sys.argv[4]))
results = saved["messages"][3]["content"]
msgs = [{"role": "system", "content": saved["messages"][0]["content"]},
        {"role": "user", "content": "Summarize these search results in detail, then say who won.\n\n" + "\n\n".join([results] * 3)}]
ids = tok.encode(render(msgs), add_special_tokens=False).ids
if len(sys.argv) > 5: ids = ids[:int(sys.argv[5])]
print("prompt tokens", len(ids))
a, b = LM(cpu + "/" + (sys.argv[7] if len(sys.argv) > 7 else "orig.onnx")), LM(cpu + "/" + (sys.argv[6] if len(sys.argv) > 6 else "mod.onnx"))
toks, la = L.generate(a, ids, 12)
_, lb = L.generate(b, ids, 12, forced=toks)
diffs = [float(np.max(np.abs(x - y))) for x, y in zip(la, lb)]
agree = sum(int(np.argmax(x) == np.argmax(y)) for x, y in zip(la, lb))
def kl(x, y):
    px = np.exp(x - x.max()); px /= px.sum(); py = np.exp(y - y.max()); py /= py.sum()
    return float(np.sum(px * (np.log(px + 1e-12) - np.log(py + 1e-12))))
print("steps", len(la), "max |logit diff| per step: max", max(diffs), "mean", sum(diffs) / len(diffs))
print("top-1 agreement", agree, "/", len(la), "max KL", max(kl(x, y) for x, y in zip(la, lb)))
print("greedy text:", tok.decode(toks)[:300])
