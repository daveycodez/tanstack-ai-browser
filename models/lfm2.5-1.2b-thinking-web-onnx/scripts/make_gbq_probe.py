import sys, numpy as np, onnx
from onnx import helper, TensorProto, numpy_helper
out = sys.argv[1]
rng = np.random.default_rng(0)
V, D, B = 16, 64, 32
for dt, sdt in [("uint8", TensorProto.FLOAT), ("uint8", TensorProto.FLOAT16), ("uint4", TensorProto.FLOAT), ("int4", TensorProto.FLOAT)]:
    packed = rng.integers(0, 256, size=(V, D // 2), dtype=np.uint8)
    if dt == "uint8":
        q = numpy_helper.from_array(packed, "q")
    else:
        q = helper.make_tensor("q", TensorProto.UINT4 if dt == "uint4" else TensorProto.INT4, [V, D], packed.tobytes(), raw=True)
    sc = rng.random((V, D // B)).astype(np.float16 if sdt == TensorProto.FLOAT16 else np.float32)
    inits = [q, numpy_helper.from_array(sc, "s")]
    ins = ["q", "ids", "s"]
    node = helper.make_node("GatherBlockQuantized", ins, ["y"], domain="com.microsoft", bits=4, block_size=B, gather_axis=0, quantize_axis=1)
    g = helper.make_graph([node], "g", [helper.make_tensor_value_info("ids", TensorProto.INT64, [1, 3])], [helper.make_tensor_value_info("y", sdt, [1, 3, D])], inits)
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 21), helper.make_opsetid("com.microsoft", 1)]); m.ir_version = 10
    p = f"{out}/gbq_{dt}_{'f16' if sdt == TensorProto.FLOAT16 else 'f32'}.onnx"
    onnx.save(m, p); print(p)
