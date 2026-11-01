import sys, os, json, time, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qlib import *
from onnx import helper
q4 = ExtReader(sys.argv[1]); f16 = ExtReader(sys.argv[2]); hdir = sys.argv[3]
hmap = json.load(open(hdir + '/map.json'))
nodes = {n.name: n for n in q4.m.graph.node if n.op_type == 'MatMulNBits'}
CLIP = tuple(np.linspace(1.0, 0.7, 13))
for name in sys.argv[4:]:
    n = nodes[name]; at = {x.name: helper.get_attribute_value(x) for x in n.attribute}; N, K = at['N'], at['K']
    wn = name.replace('/MatMul_Quant', '/MatMul').strip('/').replace('/', '.').replace('.MatMul', '.MatMul.weight')
    W = f16.get(wn).astype(np.float32).T; H = np.load(os.path.join(hdir, hmap[wn]))
    def loss(Wq): E = (Wq - W); return float(np.einsum('nk,kl,nl->', E, H, E, optimize=True) / np.einsum('nk,kl,nl->', W, H, W, optimize=True))
    zp = q4.get(n.input[3]) if len(n.input) > 3 and n.input[3] else None
    r = {'orig_bs32': loss(dequant(q4.get(n.input[1]), q4.get(n.input[2]), zp, N, K, 32))}
    for gs in [32, 64, 128]:
        r[f'rtnclip_bs{gs}'] = loss(dequant(*quantize(W, gs, True, CLIP), N, K, gs))
        t = time.time(); r[f'gptq_bs{gs}'] = loss(dequant(*gptq(W, H, gs, True, (1.0,)), N, K, gs)); tt = time.time() - t
        r[f'gptq_clip_bs{gs}'] = loss(dequant(*gptq(W, H, gs, True, CLIP), N, K, gs))
    print(name, f'gptq time {tt:.1f}s'); [print(f'   {k:18s} {v:.5f}') for k, v in r.items()]
