# python -I cmp_node.py node_out.json py_prefix name...
import sys, json, numpy as np
nj = json.load(open(sys.argv[1])); nl = np.fromfile(sys.argv[1].replace(".json", ".logits.bin"), np.float32).reshape(len(nj["top5"]), -1)
def lsm(x): x = x.astype(np.float64); x = x - x.max(-1, keepdims=True); return x - np.log(np.exp(x).sum(-1, keepdims=True))
for name in sys.argv[3:]:
    pj = json.load(open(f"{sys.argv[2]}.{name}.json")); pl = np.fromfile(f"{sys.argv[2]}.{name}.logits.bin", np.float32).reshape(len(pj["top5"]), -1)
    same = next((i for i, (a, b) in enumerate(zip(nj["tokens"], pj["tokens"])) if a != b), len(nj["tokens"]))
    n = min(same + 1, len(nl))   # rows computed on identical inputs
    d = np.abs(nl[:n] - pl[:n]).max(-1)
    lp, lq = lsm(pl[:n]), lsm(nl[:n]); kl = (np.exp(lp) * (lp - lq)).sum(-1)
    top1 = np.mean([nj["top5"][i][0] == pj["top5"][i][0] for i in range(n)])
    top5same = np.mean([nj["top5"][i] == pj["top5"][i] for i in range(n)])
    print(f"vs {name}: greedy tokens identical for {same}/{len(nj['tokens'])}; over {n} rows: top1 agree {top1:.3f}, top5 lists identical {top5same:.3f}, max|dlogit| {d.max():.4f} (prompt-end {d[0]:.4f}), KL mean {kl.mean():.2e} max {kl.max():.2e}")
