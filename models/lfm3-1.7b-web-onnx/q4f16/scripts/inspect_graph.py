import sys, onnx, collections
from onnx import helper, numpy_helper, TensorProto
m = onnx.load(sys.argv[1], load_external_data=False)
g = m.graph
print("opsets", [(o.domain, o.version) for o in m.opset_import])
print("inputs", [(i.name, [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]) for i in g.input][:8], len(g.input))
print("outputs", [o.name for o in g.output][:4], len(g.output))
ops = collections.Counter((n.domain, n.op_type) for n in g.node)
for k,v in sorted(ops.items(), key=lambda x:-x[1]): print(k, v)
def tsize(t):
    if t.data_location == TensorProto.EXTERNAL:
        d = {e.key:e.value for e in t.external_data}
        return int(d.get('length', 0)), int(d.get('offset',0))
    return len(t.raw_data) if t.raw_data else numpy_helper.to_array(t).nbytes, -1
inits = {t.name:t for t in g.initializer}
consumers = collections.defaultdict(list)
for n in g.node:
    for i,x in enumerate(n.input): consumers[x].append((n,i))
# constants in nodes
const_bytes = 0
for n in g.node:
    if n.op_type=='Constant':
        for a in n.attribute:
            if a.t: const_bytes += len(a.t.raw_data)
print("Constant node bytes", const_bytes)
rows=[]
for name,t in inits.items():
    sz,off = tsize(t)
    rows.append((name, TensorProto.DataType.Name(t.data_type), list(t.dims), sz, off, [(c.op_type, i, c.name) for c,i in consumers[name]]))
import json
json.dump(rows, open(sys.argv[2],'w'))
print(len(rows), "initializers, total", sum(r[3] for r in rows))
# matmulnbits attrs
attrs = collections.Counter()
for n in g.node:
    if n.op_type in ('MatMulNBits','GatherBlockQuantized'):
        a = {x.name: helper.get_attribute_value(x) for x in n.attribute}
        attrs[(n.op_type, tuple(sorted(a.items())), len(n.input))] += 1
for k,v in attrs.items(): print(v, k)
