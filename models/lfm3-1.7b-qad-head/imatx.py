"""Importance-matrix helpers for token_embd.weight (llama-imatrix GGUF format: <name>.in_sum2 and <name>.counts).
usage:
  imatx.py <gguf-py dir> show <a.gguf> [b.gguf]   the head's importance vector (mean squared final hidden state per column); correlation a vs b
  imatx.py <gguf-py dir> flat <in.gguf> <out.gguf>  copy with token_embd's importance set to 1 everywhere (a control: same search, no data)
"""
import sys, numpy as np
sys.path.insert(0, sys.argv[1])
import gguf

K = "token_embd.weight"


def vec(path):
    r = gguf.GGUFReader(path)
    t = {x.name: np.asarray(x.data, dtype=np.float64) for x in r.tensors if x.name.startswith(K)}
    return t[K + ".in_sum2"].reshape(-1) / t[K + ".counts"].reshape(-1)[0], r


cmd = sys.argv[2]
if cmd == "show":
    a, _ = vec(sys.argv[3])
    print(f"{sys.argv[3].rsplit('/', 1)[-1]}: {a.size} columns, mean {a.mean():.4g}, max/median {a.max() / np.median(a):.1f}, "
          f"top 1% of columns hold {np.sort(a)[-a.size // 100:].sum() / a.sum() * 100:.1f}% of the importance")
    if len(sys.argv) > 4:
        b, _ = vec(sys.argv[4])
        print(f"vs {sys.argv[4].rsplit('/', 1)[-1]}: Pearson {np.corrcoef(a, b)[0, 1]:.4f}, log-Pearson {np.corrcoef(np.log(a), np.log(b))[0, 1]:.4f}")
elif cmd == "flat":
    import shutil
    shutil.copyfile(sys.argv[3], sys.argv[4])
    r = gguf.GGUFReader(sys.argv[4], "r+")
    t = {x.name: x for x in r.tensors}
    t[K + ".in_sum2"].data[...] = np.asarray(t[K + ".counts"].data).reshape(-1)[0]
    r.data.flush()
else:
    sys.exit(__doc__)
