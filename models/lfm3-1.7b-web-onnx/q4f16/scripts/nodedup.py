"""Graph-only edit: feed lm_head's MatMulNBits the embedding blob directly (2-D [V, K/2])
instead of through a Reshape that ORT constant-folds into a second 131 MB copy.
usage: nodedup.py <in.onnx> <out.onnx>   (out must sit next to the same .onnx_data)"""
import sys, onnx
m = onnx.load(sys.argv[1], load_external_data=False); g = m.graph
rs = [n for n in g.node if n.op_type == 'Reshape' and n.input[0] == 'model_embed_tokens_weight_quant']
assert len(rs) == 1, rs
r = rs[0]; out = r.output[0]
for n in g.node:
    for i, x in enumerate(n.input):
        if x == out: n.input[i] = r.input[0]
g.node.remove(r)
shape_name = r.input[1]
if not any(shape_name in n.input for n in g.node):
    for t in list(g.initializer):
        if t.name == shape_name: g.initializer.remove(t)
onnx.save(m, sys.argv[2]); print('removed', r.name)
