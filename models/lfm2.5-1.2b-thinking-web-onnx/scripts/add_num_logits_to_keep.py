"""Apply the num_logits_to_keep edit (as in daveycodez/LFM2.5-1.2B-Thinking-Web q4f16) to a Liquid LFM2.5 ONNX graph.
Graph-only: external data refs are left untouched (loaded with load_external_data=False, written with SerializeToString)."""
import sys, onnx, numpy as np
from onnx import helper, numpy_helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src, load_external_data=False)
g = m.graph
assert 'num_logits_to_keep' not in [i.name for i in g.input]

FINAL = '/model/layers.16/final_norm_layernorm/output_0'
P = '/lm_head/num_logits_to_keep'

# 1. new scalar int64 input, appended last
g.input.append(helper.make_tensor_value_info('num_logits_to_keep', TensorProto.INT64, []))

# 2. three int64 constants, appended after existing initializers
for name, val in [(P + '/axes', 0), (P + '/ends', 2147483647), (P + '/slice_axes', 1)]:
    g.initializer.append(numpy_helper.from_array(np.array([val], dtype=np.int64), name))

# 3. Neg -> Unsqueeze -> Slice(final_norm, -n, INT32_MAX, axis 1), inserted right before the LM head
idx = [i for i, n in enumerate(g.node) if n.name == '/lm_head/MatMul_Quant']
assert len(idx) == 1
idx = idx[0]
lm = g.node[idx]
assert lm.op_type == 'MatMulNBits' and lm.input[0] == FINAL
consumers = [n.name for n in g.node if FINAL in n.input]
assert consumers == ['/lm_head/MatMul_Quant'], consumers
new_nodes = [
    helper.make_node('Neg', ['num_logits_to_keep'], [P + '/Neg/output_0'], name=P + '/Neg'),
    helper.make_node('Unsqueeze', [P + '/Neg/output_0', P + '/axes'], [P + '/Unsqueeze/output_0'], name=P + '/Unsqueeze'),
    helper.make_node('Slice', [FINAL, P + '/Unsqueeze/output_0', P + '/ends', P + '/slice_axes'], [P + '/Slice/output_0'], name=P + '/Slice'),
]
lm.input[0] = P + '/Slice/output_0'
for k, n in enumerate(new_nodes):
    g.node.insert(idx + k, n)

# 4. logits' sequence dim gets its own symbolic name
out = [o for o in g.output if o.name == 'logits']
assert len(out) == 1
d = out[0].type.tensor_type.shape.dim[1]
assert d.dim_param == 'sequence_length'
d.dim_param = 'logits_sequence_length'

# 5. drop stale value_info for the LM head output (its sequence dim changed)
for v in list(g.value_info):
    if v.name == lm.output[0]:
        g.value_info.remove(v)


with open(dst, 'wb') as f:
    f.write(m.SerializeToString())
print('wrote', dst)
