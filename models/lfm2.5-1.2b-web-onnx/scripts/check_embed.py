# Exhaustively compare the new standard-op embedding subgraph with the original GatherBlockQuantized.
import sys, numpy as np, onnx, onnxruntime as ort
from onnx import helper, TensorProto
W = sys.argv[1]
new = onnx.load(f'{W}/out/onnx/model_q4.onnx', load_external_data=True)
orig = onnx.load(f'{W}/dl/liquid/onnx/model_q4.onnx', load_external_data=False)
gbq = [n for n in orig.graph.node if n.op_type == 'GatherBlockQuantized'][0]
gbq2 = onnx.NodeProto(); gbq2.CopyFrom(gbq); gbq2.output[0] = 'ref'
nodes = [n for n in new.graph.node if n.name.startswith('/model/embed_tokens/Dequant/')]
need = {i for n in nodes + [gbq2] for i in n.input}
inits = [t for t in new.graph.initializer if t.name in need]
g = helper.make_graph(nodes + [gbq2], 'emb', [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['b', 's'])],
    [helper.make_tensor_value_info('/model/embed_tokens/Gather/output_0', TensorProto.FLOAT, None), helper.make_tensor_value_info('ref', TensorProto.FLOAT, None)], inits)
m = helper.make_model(g, opset_imports=list(new.opset_import)); m.ir_version = new.ir_version
s = ort.InferenceSession(m.SerializeToString(), providers=['CPUExecutionProvider'])
ids = np.arange(65536, dtype=np.int64).reshape(4, 16384)   # all token ids, batch 4
a, b = s.run(None, {'input_ids': ids})
print('shape', a.shape, 'bit-exact', np.array_equal(a, b), 'maxdiff', float(np.abs(a - b).max()), 'nan', bool(np.isnan(a).any()))
a1, b1 = s.run(None, {'input_ids': np.array([[1, 6, 65535]], np.int64)})
print('small batch shape', a1.shape, 'bit-exact', np.array_equal(a1, b1))
