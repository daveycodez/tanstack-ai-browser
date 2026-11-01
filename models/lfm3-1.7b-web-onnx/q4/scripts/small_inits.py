import onnx, sys
from onnx import numpy_helper
m = onnx.load(sys.argv[1], load_external_data=False)
for t in m.graph.initializer:
    if not t.external_data and len(t.dims)<=1 and (not t.dims or t.dims[0]<8):
        print(t.name, onnx.TensorProto.DataType.Name(t.data_type), numpy_helper.to_array(t))
    elif not t.external_data: print("INLINE", t.name, list(t.dims), onnx.TensorProto.DataType.Name(t.data_type))
