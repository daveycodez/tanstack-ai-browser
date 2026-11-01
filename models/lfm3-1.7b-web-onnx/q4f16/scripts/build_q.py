"""Requantize selected MatMulNBits nodes of an already-built graph (e.g. gptq128_v80k) with GPTQ.
usage: build_q.py <src.onnx> <fp16.onnx> <Hdir> <outdir> <spec> [<spec> ...]
spec = <name-substring-regex>:<bits>:<block>   e.g. 'layers\\.(8|9|10)/mlp/':2:64  or '.':4:256"""
import sys, os, re, json, time, numpy as np, onnx
from onnx import helper
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qlib import ExtReader, gptq_n
from writer import write_model
src_p, f16_p, hdir, outdir = sys.argv[1:5]
specs = [(re.compile(s.rsplit(':', 2)[0]), int(s.rsplit(':', 2)[1]), int(s.rsplit(':', 2)[2])) for s in sys.argv[5:]]
src = ExtReader(src_p); f16 = ExtReader(f16_p); m = src.m; g = m.graph
HMAP = json.load(open(os.path.join(hdir, 'map.json')))
CLIP = tuple(np.linspace(1.0, 0.7, 13)); new = {}; t0 = time.time()
def setattr_(n, k, v):
    for a in n.attribute:
        if a.name == k: a.i = v; return
    n.attribute.append(helper.make_attribute(k, v))
for n in g.node:
    if n.op_type != 'MatMulNBits' or n.name.startswith('/lm_head'): continue
    sp = next(((b, bs) for rx, b, bs in specs if rx.search(n.name)), None)
    if sp is None: continue
    bits, bs = sp
    at = {x.name: helper.get_attribute_value(x) for x in n.attribute}; N, K = at['N'], at['K']
    wname = n.name.replace('/MatMul_Quant', '/MatMul').strip('/').replace('/', '.').replace('.MatMul', '.MatMul.weight')
    W = f16.get(wname).astype(np.float32).T
    qw, s, z = gptq_n(W, np.load(os.path.join(hdir, HMAP[wname])), bs, bits, CLIP)
    new[n.input[1]] = qw; new[n.input[2]] = s
    zname = n.input[3] if len(n.input) > 3 and n.input[3] else n.input[1].replace('_quant', '_zp')
    new[zname] = z
    while len(n.input) < 4: n.input.append('')
    n.input[3] = zname
    setattr_(n, 'bits', bits); setattr_(n, 'block_size', bs)
    print(f'{n.name} -> {bits}bit bs{bs} {time.time()-t0:.0f}s', flush=True)
off = write_model(m, src, new, outdir); print('data bytes', off)
