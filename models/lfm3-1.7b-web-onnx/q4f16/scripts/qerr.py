import sys, numpy as np
sys.path.insert(0, sys.argv[1]); from qlib import *
q4 = ExtReader(sys.argv[2]); f16 = ExtReader(sys.argv[3])
clip = tuple(np.linspace(1.0, 0.7, 13))
from onnx import helper
nodes = {n.name: n for n in q4.m.graph.node if n.op_type == 'MatMulNBits'}
def rel(a, b): return float(np.linalg.norm(a - b) / np.linalg.norm(b))
for name in ['/model/layers.0/mlp/gate_proj/MatMul_Quant', '/model/layers.10/mlp/down_proj/MatMul_Quant', '/model/layers.5/conv/in_proj/MatMul_Quant', '/model/layers.2/attn/q_proj/MatMul_Quant', '/model/layers.20/mlp/up_proj/MatMul_Quant']:
    n = nodes[name]; a = {x.name: helper.get_attribute_value(x) for x in n.attribute}
    N, K = a['N'], a['K']
    W = f16.get(name.replace('/MatMul_Quant', '/MatMul').strip('/').replace('/', '.').replace('.MatMul', '.MatMul.weight')).astype(np.float32).T  # [N,K]
    zp = q4.get(n.input[3]) if len(n.input) > 3 and n.input[3] else None
    orig = dequant(q4.get(n.input[1]), q4.get(n.input[2]), zp, N, K, 32)
    res = {'orig_bs32' + ('_asym' if zp is not None else '_sym'): rel(orig, W)}
    for bs in [32, 64, 128]:
        for asym in [True, False]:
            for cl, lab in [((1.0,), 'rtn'), (clip, 'clip')]:
                if bs == 32 and lab == 'clip' and not asym: continue
                qw, s, z = quantize(W, bs, asym, cl)
                res[f'bs{bs}_{"asym" if asym else "sym"}_{lab}'] = rel(dequant(qw, s, z, N, K, bs), W)
    print(name, N, K); [print(f'   {k:22s} {v:.4f}') for k, v in res.items()]
