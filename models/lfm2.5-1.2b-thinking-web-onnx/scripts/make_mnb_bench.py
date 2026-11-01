import sys, numpy as np, onnx
from onnx import helper, numpy_helper, TensorProto
out = sys.argv[1]; K, N, B = 2048, 8192, 32
rng = np.random.default_rng(0)
w = numpy_helper.from_array(rng.integers(0, 256, (N, K // B, B // 2), dtype=np.uint8), 'w')
s = numpy_helper.from_array(rng.random((N, K // B), dtype=np.float32) * 0.01, 's')
z = numpy_helper.from_array(rng.integers(0, 256, (N, K // B // 2), dtype=np.uint8), 'z')
n = helper.make_node('MatMulNBits', ['x', 'w', 's', 'z'], ['y'], domain='com.microsoft', K=K, N=N, bits=4, block_size=B)
g = helper.make_graph([n], 'g', [helper.make_tensor_value_info('x', TensorProto.FLOAT, [1, None, K])], [helper.make_tensor_value_info('y', TensorProto.FLOAT, [1, None, N])], [w, s, z])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 21), helper.make_opsetid('com.microsoft', 1)]); m.ir_version = 10
onnx.save(m, f'{out}/mnb.onnx')
wf = numpy_helper.from_array(rng.random((K, N), dtype=np.float32), 'wf')
g2 = helper.make_graph([helper.make_node('MatMul', ['x', 'wf'], ['y'])], 'g', [helper.make_tensor_value_info('x', TensorProto.FLOAT, [1, None, K])], [helper.make_tensor_value_info('y', TensorProto.FLOAT, [1, None, N])], [wf])
m2 = helper.make_model(g2, opset_imports=[helper.make_opsetid('', 21)]); m2.ir_version = 10
onnx.save(m2, f'{out}/matmul_f32.onnx')
