import sys, os, numpy as np, onnx, onnxruntime as ort, json
from onnx import helper, TensorProto, numpy_helper
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qlib import gptq_n, dequant_n
outdir = sys.argv[1]; rng = np.random.default_rng(0)
res = {}
for bits, bs in [(2, 64), (4, 256), (4, 128)]:
    N, K, M = 256, 512, 3
    W = rng.standard_normal((N, K)).astype(np.float32); H = np.eye(K, dtype=np.float32)
    qw, s, z = gptq_n(W, H, bs, bits)
    Wd = dequant_n(qw, s, z, N, K, bs, bits)
    X = rng.standard_normal((M, K)).astype(np.float16)
    node = helper.make_node('MatMulNBits', ['x', 'b', 's', 'z'], ['y'], domain='com.microsoft', K=K, N=N, bits=bits, block_size=bs, accuracy_level=4)
    g = helper.make_graph([node], 'g', [helper.make_tensor_value_info('x', TensorProto.FLOAT16, [M, K])], [helper.make_tensor_value_info('y', TensorProto.FLOAT16, [M, N])],
                          [numpy_helper.from_array(qw, 'b'), numpy_helper.from_array(s, 's'), numpy_helper.from_array(z, 'z')])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 21), helper.make_opsetid('com.microsoft', 1)]); m.ir_version = 10
    p = os.path.join(outdir, f'mm_{bits}_{bs}.onnx'); onnx.save(m, p)
    y = ort.InferenceSession(p, providers=['CPUExecutionProvider']).run(None, {'x': X})[0].astype(np.float32)
    ref = X.astype(np.float32) @ Wd.T
    np.save(os.path.join(outdir, f'x_{bits}_{bs}.npy'), X); np.save(os.path.join(outdir, f'ref_{bits}_{bs}.npy'), ref)
    X.tofile(os.path.join(outdir, f'x_{bits}_{bs}.bin'))
    res[f'{bits}bit_bs{bs}'] = {'cpu_rel_err_vs_numpy_dequant': float(np.abs(y - ref).max() / np.abs(ref).max())}
print(json.dumps(res))
