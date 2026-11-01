import onnx, sys, collections
from onnx import TensorProto, helper
m = onnx.load(sys.argv[1], load_external_data=False)
g = m.graph
print("opset", [(o.domain, o.version) for o in m.opset_import], "ir", m.ir_version)
print("INPUTS"); [print(" ", i.name, helper.tensor_dtype_to_np_dtype(i.type.tensor_type.elem_type), [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]) for i in g.input]
print("OUTPUTS"); [print(" ", i.name, helper.tensor_dtype_to_np_dtype(i.type.tensor_type.elem_type), [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]) for i in g.output]
c = collections.Counter((n.domain, n.op_type) for n in g.node); print("OPS", c)
ic = collections.Counter(TensorProto.DataType.Name(t.data_type) for t in g.initializer); print("INIT dtypes", ic, len(g.initializer))
locs = collections.Counter(); 
for t in g.initializer:
    for e in t.external_data:
        if e.key=="location": locs[e.value]+=1
print("ext locations", locs)
print("value_info", len(g.value_info), collections.Counter(TensorProto.DataType.Name(v.type.tensor_type.elem_type) for v in g.value_info))
for n in g.node:
    if n.op_type in ("Cast",): pass
casts = collections.Counter(TensorProto.DataType.Name(a.i) for n in g.node if n.op_type=="Cast" for a in n.attribute if a.name=="to"); print("Cast to", casts)
cons = collections.Counter()
for n in g.node:
    if n.op_type=="Constant":
        for a in n.attribute:
            if a.t: cons[TensorProto.DataType.Name(a.t.data_type)]+=1
            else: cons[a.name]+=1
print("Constant nodes", cons)
for f in m.functions: print("FUNCTION", f.name)
