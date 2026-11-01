"""Apply a vocabulary trim (keep_ids.json from vocab_trim.py) to a q4f16 graph whose lm_head reads the
embedding blob directly (no Reshape). usage: vocab_model.py <src.onnx> <keep_ids.json> <outdir>"""
import sys, os, json, numpy as np, onnx
from onnx import helper
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qlib import ExtReader
from writer import write_model
src_p, keep_p, outdir = sys.argv[1:4]
keep = np.array(json.load(open(keep_p)), np.int64); V = len(keep)
src = ExtReader(src_p); m = src.m; g = m.graph
assert not any(n.op_type == 'Reshape' and n.input[0] == 'model_embed_tokens_weight_quant' for n in g.node), 'run nodedup first'
new = {k: np.ascontiguousarray(src.get(k)[keep]) for k in ['model_embed_tokens_weight_quant', 'model_embed_tokens_weight_scales', 'model_embed_tokens_weight_zp']}
for n in g.node:
    if n.op_type == 'MatMulNBits' and n.name.startswith('/lm_head'):
        for a in n.attribute:
            if a.name == 'N': a.i = V
for vi in list(g.output) + list(g.value_info):
    for d in vi.type.tensor_type.shape.dim:
        if d.dim_value == 128000: d.dim_value = V
off = write_model(m, src, new, outdir)
print('V', V, 'data bytes', off)
