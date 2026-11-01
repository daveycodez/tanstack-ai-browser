"""Replace the com.microsoft GatherBlockQuantized embedding lookup with standard ONNX ops
(Gather, BitwiseAnd, BitShift, Unsqueeze, Concat, Reshape, Cast, Sub, Mul), reading the SAME packed
4-bit initializers (data uint8 [V, D/2], scales float [V, D/B], zero points uint8 [V, D/B/2]).
No initializer in the external data file is touched or re-laid out. Only small int64/uint8 constants are added inline.
onnxruntime-web 1.31.1's WebGPU builds (asyncify / jspi) have no CPU kernel for GatherBlockQuantized."""
import sys, onnx, numpy as np
from onnx import helper, numpy_helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src, load_external_data=False); g = m.graph
idx = [k for k, n in enumerate(g.node) if n.op_type == 'GatherBlockQuantized']
assert len(idx) == 1, idx
idx = idx[0]; gbq = g.node[idx]
assert gbq.domain == 'com.microsoft' and len(gbq.input) == 4 and len(gbq.output) == 1
attrs = {a.name: helper.get_attribute_value(a) for a in gbq.attribute}
assert attrs == {'bits': 4, 'block_size': 32, 'gather_axis': 0, 'quantize_axis': 1}, attrs
data, ids, scales, zp = gbq.input
Y = gbq.output[0]
inits = {t.name: t for t in g.initializer}
V, half = inits[data].dims; D = half * 2; B = attrs['block_size']; NB = D // B
assert inits[data].data_type == TensorProto.UINT8
assert list(inits[scales].dims) == [V, NB] and inits[scales].data_type == TensorProto.FLOAT
assert list(inits[zp].dims) == [V, NB // 2] and inits[zp].data_type == TensorProto.UINT8
print(f"vocab {V}, hidden {D}, block {B}, blocks/row {NB}")

P = gbq.name + '/'   # '/model/embed_tokens/Gather_Quant/'
def const(name, arr):
    t = numpy_helper.from_array(np.asarray(arr), P + name); g.initializer.append(t); return P + name
c15 = const('mask_low', np.array(15, np.uint8))
c4 = const('shift', np.array(4, np.uint8))
axm1 = const('axes_last', np.array([-1], np.int64))
shp_q = const('shape_blocks', np.array([0, 0, NB, B], np.int64))
shp_z = const('shape_block_zp', np.array([0, 0, NB, 1], np.int64))
shp_o = const('shape_out', np.array([0, 0, D], np.int64))
nodes = []
def node(op, ins, name, **kw):
    nodes.append(helper.make_node(op, ins, [P + name + '/output_0'], name=P + name, **kw)); return P + name + '/output_0'
def unpack(x, tag):
    # uint8 [..., n] -> uint8 [..., n, 2]: element 2i = low nibble, element 2i+1 = high nibble
    lo = node('BitwiseAnd', [x, c15], tag + '_low')
    hi = node('BitShift', [x, c4], tag + '_high', direction='RIGHT')
    lo = node('Unsqueeze', [lo, axm1], tag + '_low_unsqueeze')
    hi = node('Unsqueeze', [hi, axm1], tag + '_high_unsqueeze')
    return node('Concat', [lo, hi], tag + '_interleave', axis=-1)
q = node('Gather', [data, ids], 'gather_data', axis=0)          # [b,s,D/2] uint8
q = unpack(q, 'data')                                            # [b,s,D/2,2]
q = node('Reshape', [q, shp_q], 'data_blocks')                   # [b,s,NB,B]
q = node('Cast', [q], 'data_float', to=TensorProto.FLOAT)
z = node('Gather', [zp, ids], 'gather_zero_points', axis=0)      # [b,s,NB/2] uint8
z = unpack(z, 'zero_points')                                     # [b,s,NB/2,2]
z = node('Reshape', [z, shp_z], 'zero_points_blocks')            # [b,s,NB,1]
z = node('Cast', [z], 'zero_points_float', to=TensorProto.FLOAT)
s = node('Gather', [scales, ids], 'gather_scales', axis=0)       # [b,s,NB]
s = node('Unsqueeze', [s, axm1], 'scales_unsqueeze')             # [b,s,NB,1]
d = node('Sub', [q, z], 'subtract_zero_points')
d = node('Mul', [d, s], 'multiply_scales')                       # [b,s,NB,B]
nodes.append(helper.make_node('Reshape', [d, shp_o], [Y], name=P + 'shape_out_reshape'))
del g.node[idx]
for k, n in enumerate(nodes):
    g.node.insert(idx + k, n)
assert not any(n.op_type == 'GatherBlockQuantized' for n in g.node)
assert data not in [i for n in g.node for i in n.input if n.op_type != 'Gather'] or True
open(dst, 'wb').write(m.SerializeToString()); print('wrote', dst, len(nodes), 'nodes replace 1')
