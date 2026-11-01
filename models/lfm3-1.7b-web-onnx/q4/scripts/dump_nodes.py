import onnx, sys
from onnx import helper, numpy_helper, TensorProto
m = onnx.load(sys.argv[1], load_external_data=False)
g = m.graph
inits = {t.name: t for t in g.initializer}
def desc(x):
    if x in inits:
        t = inits[x]; return f"{x}[init {TensorProto.DataType.Name(t.data_type)} {list(t.dims)}]"
    return x
for i, n in enumerate(g.node):
    attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
    attrs = {k:(v if not isinstance(v, onnx.TensorProto) else f"tensor{list(v.dims)}") for k,v in attrs.items()}
    print(i, n.domain, n.op_type, n.name, "IN:", [desc(x) for x in n.input], "OUT:", list(n.output), attrs)
