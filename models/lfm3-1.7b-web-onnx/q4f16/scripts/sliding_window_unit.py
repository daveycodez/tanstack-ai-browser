import numpy as np, onnx, onnxruntime as ort
from onnx import helper, TensorProto as TP
def model(window, with_bias):
    ins = [helper.make_tensor_value_info(n, TP.FLOAT16, s) for n, s in
           [("q", [1, "S", 2048]), ("k", [1, "S", 512]), ("v", [1, "S", 512]), ("pk", [1, 4, "P", 128]), ("pv", [1, 4, "P", 128])]]
    ins += [helper.make_tensor_value_info("seqlens_k", TP.INT32, [1]), helper.make_tensor_value_info("total", TP.INT32, [])]
    names = ["q", "k", "v", "pk", "pv", "seqlens_k", "total", "", "", "", ""]
    if with_bias:
        ins.append(helper.make_tensor_value_info("bias", TP.FLOAT16, [1, 1, "S", "T"])); names[10] = "bias"
    n = helper.make_node("GroupQueryAttention", names, ["out", "ok", "ov"], domain="com.microsoft",
                         num_heads=16, kv_num_heads=4, local_window_size=window, scale=0.0883883461356163)
    outs = [helper.make_tensor_value_info(x, TP.FLOAT16, None) for x in ["out", "ok", "ov"]]
    m = helper.make_model(helper.make_graph([n], "g", ins, outs), opset_imports=[helper.make_opsetid("", 21), helper.make_opsetid("com.microsoft", 1)], ir_version=10)
    return ort.InferenceSession(m.SerializeToString(), providers=["CPUExecutionProvider"])
rng = np.random.default_rng(0)
for S, P in [(600, 0), (1, 599), (40, 560)]:
    T = S + P
    f = lambda *s: (rng.standard_normal(s) * 2).astype(np.float16)
    feed = dict(q=f(1, S, 2048), k=f(1, S, 512), v=f(1, S, 512), pk=f(1, 4, P, 128), pv=f(1, 4, P, 128),
                seqlens_k=np.array([T - 1], np.int32), total=np.array(T, np.int32))
    a = model(256, False).run(None, feed)[0].astype(np.float32)
    qpos = np.arange(P, T)[:, None]; kpos = np.arange(T)[None, :]
    for shift in (0, 1, -1):
        bias = np.where(kpos + 256 + shift <= qpos, np.float16(-65504), np.float16(0)).astype(np.float16)[None, None]
        b = model(-1, True).run(None, dict(feed, bias=bias))[0].astype(np.float32)
        print(f"S={S} P={P} shift={shift}: max|diff| {np.abs(a - b).max():.4f}")
