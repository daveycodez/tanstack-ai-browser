"""Make a CPU-EP-runnable copy of an LFM3 graph: CPU has only a float32
CausalConvWithState kernel, so wrap each one in Casts. Graph-only; the
external data file is reused as-is (written next to the source graph)."""
import sys, os, onnx
from onnx import helper, TensorProto
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src, load_external_data=False); g = m.graph
new = []
for n in g.node:
    if n.op_type != 'CausalConvWithState':
        new.append(n); continue
    ins = []
    for i, x in enumerate(n.input):
        if not x: ins.append(x); continue
        y = x + '__f32'
        new.append(helper.make_node('Cast', [x], [y], to=TensorProto.FLOAT, name=n.name + f'/cast_in{i}'))
        ins.append(y)
    outs = []
    for i, x in enumerate(n.output):
        y = x + '__f32'
        outs.append(y)
    n2 = helper.make_node(n.op_type, ins, outs, name=n.name, domain=n.domain)
    n2.attribute.extend(n.attribute)
    new.append(n2)
    for i, x in enumerate(n.output):
        new.append(helper.make_node('Cast', [x + '__f32'], [x], to=TensorProto.FLOAT16, name=n.name + f'/cast_out{i}'))
del g.node[:]; g.node.extend(new)
onnx.save(m, dst)
print('wrote', dst)
