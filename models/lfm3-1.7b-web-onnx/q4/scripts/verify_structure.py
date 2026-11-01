import sys, onnx, numpy as np, collections
from onnx import numpy_helper, TensorProto, helper
a = onnx.load(sys.argv[1], load_external_data=True)   # q4f16
b = onnx.load(sys.argv[2], load_external_data=True)   # q4
mb = onnx.load(sys.argv[2], load_external_data=False)
ia = {t.name: t for t in a.graph.initializer}; ib = {t.name: t for t in b.graph.initializer}
print("init only in q4f16:", sorted(set(ia) - set(ib)))
print("init only in q4:", sorted(set(ib) - set(ia)))
same_u8 = 0; widened = 0; other = 0
for k in set(ia) & set(ib):
    x, y = ia[k], ib[k]
    if list(x.dims) != list(y.dims): print('dims differ (same element count required):', k, list(x.dims), list(y.dims)); assert np.prod(x.dims) == np.prod(y.dims)
    if x.data_type == TensorProto.UINT8:
        assert y.data_type == TensorProto.UINT8 and numpy_helper.to_array(x).tobytes() == numpy_helper.to_array(y).tobytes(), k
        same_u8 += 1
    elif x.data_type == TensorProto.FLOAT16:
        assert y.data_type == TensorProto.FLOAT
        xa = numpy_helper.to_array(x).astype(np.float32); ya = numpy_helper.to_array(y)
        assert np.array_equal(xa, ya), k
        widened += 1
    else:
        assert x.data_type == y.data_type and np.array_equal(numpy_helper.to_array(x), numpy_helper.to_array(y)), k
        other += 1
print(f"uint8 byte-identical: {same_u8}, fp16->fp32 exact: {widened}, other identical: {other}")
u8bytes = sum(numpy_helper.to_array(t).nbytes for t in ib.values() if t.data_type == TensorProto.UINT8)
print("packed uint8 bytes:", u8bytes)
io = lambda m: ([(i.name, TensorProto.DataType.Name(i.type.tensor_type.elem_type)) for i in m.graph.input], [(o.name, TensorProto.DataType.Name(o.type.tensor_type.elem_type)) for o in m.graph.output])
(ai, ao), (bi, bo) = io(a), io(b)
assert [n for n, _ in ai] == [n for n, _ in bi] and [n for n, _ in ao] == [n for n, _ in bo]
print("inputs/outputs same names & order;", "q4 dtypes:", collections.Counter(t for _, t in bi + bo))
na = {n.name: n for n in a.graph.node}; nb = {n.name: n for n in b.graph.node}
print("nodes only in q4f16:", sorted(set(na) - set(nb)))
print("nodes only in q4:", sorted(set(nb) - set(na)))
for k in set(na) & set(nb):
    x, y = na[k], nb[k]
    assert x.op_type == y.op_type and x.domain == y.domain
    if list(x.input) != list(y.input): print("inputs differ:", k, [ (p, q) for p, q in zip(x.input, y.input) if p != q])
    ax = {t.name: helper.get_attribute_value(t) for t in x.attribute}; ay = {t.name: helper.get_attribute_value(t) for t in y.attribute}
    if ax != ay: print("attrs differ:", k, {kk: (ax.get(kk), ay.get(kk)) for kk in set(ax) | set(ay) if ax.get(kk) != ay.get(kk)})
locs = collections.Counter(e.value for t in mb.graph.initializer for e in t.external_data if e.key == "location")
print("external locations:", locs, "inline initializers:", sum(1 for t in mb.graph.initializer if not t.external_data))
print("ops:", collections.Counter((n.domain or "ai.onnx") + ":" + n.op_type for n in b.graph.node))
