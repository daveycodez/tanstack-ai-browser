"""Does a head variant's tool score come from the head itself, and mostly from the <tool_call> row?
Takes the QAD model's final hidden state at the reply's first position for every tool prompt (from a running
`llama-server --embeddings --pooling none` on the QAD file), then predicts each variant's P(<tool_call>) from that same hidden
state and the variant's head, (a) with the whole head swapped and (b) with only the <tool_call> row swapped.
usage: toolrow.py <gguf-py dir> <port> <sets dir> <qad.gguf> <variant.gguf> ..."""
import sys, os, json, urllib.request, numpy as np
sys.path.insert(0, sys.argv[1])
import gguf
from gguf.quants import dequantize
port, D, qad = sys.argv[2:5]
TC = 125019
Hs = []
for lang in sorted(os.listdir(D)):
    for p in json.load(open(os.path.join(D, lang, "tool_prompts.json")))["prompts"]:
        r = urllib.request.Request(f"http://127.0.0.1:{port}/embedding", data=json.dumps({"content": p["ids"]}).encode(), headers={"Content-Type": "application/json"})
        Hs.append(json.load(urllib.request.urlopen(r, timeout=600))[0]["embedding"][-1])
Hs = np.asarray(Hs, dtype=np.float32)
def head(p):
    t = next(x for x in gguf.GGUFReader(p).tensors if x.name == "token_embd.weight")
    return dequantize(np.asarray(t.data), t.tensor_type).reshape(-1, 2048).astype(np.float32)
def ptc(Z):
    Z = Z - Z.max(1, keepdims=True); P = np.exp(Z); return P[:, TC] / P.sum(1)
W0 = head(qad); Z0 = Hs @ W0.T; p0 = ptc(Z0)
print(f"{'QAD (shipped)':28s} predicted mean P {p0.mean():.3f}")
for v in sys.argv[5:]:
    W = head(v); Z = Hs @ W.T; pa = ptc(Z)
    Zr = Z0.copy(); Zr[:, TC] = Hs @ W[TC]; pr = ptc(Zr)
    print(f"{v.rsplit('/', 1)[-1]:28s} whole head: mean P {pa.mean():.3f}   only the <tool_call> row: {pr.mean():.3f}   "
          f"<tool_call> logit shift mean {(Z[:, TC] - Z0[:, TC]).mean():+.3f}", flush=True)
