import sys, onnx
from onnx import helper, numpy_helper
def load(p): return onnx.load(p, load_external_data=False)
def vi(v):
    t=v.type.tensor_type
    return (v.name, onnx.TensorProto.DataType.Name(t.elem_type), [d.dim_param or d.dim_value for d in t.shape.dim])
def nodekey(n): return (n.op_type, tuple(n.input), tuple(n.output), tuple(sorted((a.name, str(helper.get_attribute_value(a))) for a in n.attribute)))
def init_info(t):
    ext = {e.key:e.value for e in t.external_data}
    return (onnx.TensorProto.DataType.Name(t.data_type), tuple(t.dims), t.data_location, tuple(sorted(ext.items())), t.raw_data if not ext else None)
a=load(sys.argv[1]); b=load(sys.argv[2])
print("ir/opset/producer A:", a.ir_version, [(o.domain,o.version) for o in a.opset_import], a.producer_name, a.producer_version)
print("ir/opset/producer B:", b.ir_version, [(o.domain,o.version) for o in b.opset_import], b.producer_name, b.producer_version)
print("metadata A", [(p.key,p.value) for p in a.metadata_props]); print("metadata B", [(p.key,p.value) for p in b.metadata_props])
ga,gb=a.graph,b.graph
print("graph names", ga.name, gb.name)
ia=[vi(x) for x in ga.input]; ib=[vi(x) for x in gb.input]
print("inputs only A:", [x for x in ia if x not in ib]); print("inputs only B:", [x for x in ib if x not in ia])
print("input order same (common):", [x[0] for x in ia if x in ib]==[x[0] for x in ib if x in ia])
oa=[vi(x) for x in ga.output]; ob=[vi(x) for x in gb.output]
print("outputs only A:", [x for x in oa if x not in ob]); print("outputs only B:", [x for x in ob if x not in oa])
print("n nodes", len(ga.node), len(gb.node), "n init", len(ga.initializer), len(gb.initializer), "value_info", len(ga.value_info), len(gb.value_info))
na=[nodekey(n) for n in ga.node]; nb=[nodekey(n) for n in gb.node]
sa=set(na); sb=set(nb)
for i,n in enumerate(ga.node):
    if nodekey(n) not in sb: print("node only A @%d:"%i, n.name, nodekey(n))
for i,n in enumerate(gb.node):
    if nodekey(n) not in sa: print("node only B @%d:"%i, n.name, nodekey(n))
# node names
print("node names differ:", sum(1 for x,y in zip(ga.node,gb.node) if x.name!=y.name))
ina={t.name:init_info(t) for t in ga.initializer}; inb={t.name:init_info(t) for t in gb.initializer}
for k in ina:
    if k not in inb: print("init only A:", k, ina[k][:3])
    elif ina[k]!=inb[k]: print("init differs:", k, ina[k][:4], inb[k][:4])
for k in inb:
    if k not in ina:
        t=[t for t in gb.initializer if t.name==k][0]
        print("init only B:", k, inb[k][:3], numpy_helper.to_array(t) if not t.external_data else 'ext')
via={v.name:vi(v) for v in ga.value_info}; vib={v.name:vi(v) for v in gb.value_info}
print("value_info only A:", [via[k] for k in via if k not in vib]); print("value_info only B:", [vib[k] for k in vib if k not in via])
print("value_info differ:", [(via[k],vib[k]) for k in via if k in vib and via[k]!=vib[k]])
# ordering check
print("node order (excluding added) same:", [x for x in na if x in sb]==[x for x in nb if x in sa])
print("init order (common) same:", [t.name for t in ga.initializer if t.name in inb]==[t.name for t in gb.initializer if t.name in ina])
print("functions", len(a.functions), len(b.functions), "doc", repr(ga.doc_string)[:80], repr(gb.doc_string)[:80])
