"""Error of each variant's head against a reference head: plain relative error (what the embedding lookup sees) and
output-weighted relative error tr(E C Eᵀ)/tr(W C Wᵀ) with C = E[h hᵀ] of the final hidden states (what the LM head sees),
plus the <tool_call> row (125019) alone.
usage: headerr.py <gguf-py dir> <cov.npz> <reference.gguf> <variant.gguf> ..."""
import sys, numpy as np
sys.path.insert(0, sys.argv[1])
import gguf
from gguf.quants import dequantize
C = np.load(sys.argv[2])["C"].astype(np.float32)
def head(p):
    t = next(x for x in gguf.GGUFReader(p).tensors if x.name == "token_embd.weight")
    return dequantize(np.asarray(t.data), t.tensor_type).reshape(-1, 2048).astype(np.float32)
W = head(sys.argv[3]); WC = np.sum((W @ C) * W); TC = 125019
for p in sys.argv[4:]:
    E = head(p) - W
    e = E[TC]; w = W[TC]
    print(f"{p.rsplit('/', 1)[-1]:28s} rel {np.linalg.norm(E) / np.linalg.norm(W):.5f}  out-weighted {np.sum((E @ C) * E) / WC:.6f}  "
          f"<tool_call> row: rel {np.linalg.norm(e) / np.linalg.norm(w):.4f} out-weighted {e @ C @ e / (w @ C @ w):.6f}", flush=True)
