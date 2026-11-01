import sys, os, onnx, numpy as np, onnxruntime as ort
from onnx import helper, TensorProto
root = sys.argv[1]; stage = f"{root}/out/stage"
OUT = '/model/embed_tokens/Gather/output_0'
def submodel(src, dst):
    m = onnx.load(src, load_external_data=False); g = m.graph
    # nodes from first consumer of input_ids up to the producer of OUT (contiguous block)
    start = next(k for k, n in enumerate(g.node) if 'input_ids' in n.input and n.op_type in ('GatherBlockQuantized', 'Gather'))
    end = next(k for k, n in enumerate(g.node) if OUT in n.output)
    nodes = list(g.node[start:end + 1])
    used = {i for n in nodes for i in n.input}
    inits = [t for t in g.initializer if t.name in used]
    sg = helper.make_graph(nodes, 'emb', [helper.make_tensor_value_info('input_ids', TensorProto.INT64, [1, None])],
                           [helper.make_tensor_value_info(OUT, TensorProto.FLOAT, [1, None, 2048])], inits)
    sm = helper.make_model(sg, opset_imports=m.opset_import); sm.ir_version = m.ir_version
    open(dst, 'wb').write(sm.SerializeToString())
    return [n.op_type for n in nodes]
if not os.path.exists(f"{stage}/model_q4.onnx_data"):
    os.symlink(f"{root}/dl/liquid/onnx/model_q4.onnx_data", f"{stage}/model_q4.onnx_data")
print('orig ops', submodel(f"{root}/dl/liquid/onnx/model_q4.onnx", f"{stage}/emb_orig.onnx"))
print('new  ops', submodel(f"{root}/out/onnx/model_q4.onnx", f"{stage}/emb_new.onnx"))
a = ort.InferenceSession(f"{stage}/emb_orig.onnx", providers=['CPUExecutionProvider'])
b = ort.InferenceSession(f"{stage}/emb_new.onnx", providers=['CPUExecutionProvider'])
mx = 0.0; exact = True
for s in range(0, 65536, 4096):
    ids = np.arange(s, s + 4096, dtype=np.int64)[None]
    ya = a.run(None, {'input_ids': ids})[0]; yb = b.run(None, {'input_ids': ids})[0]
    exact &= bool(np.array_equal(ya, yb)); mx = max(mx, float(np.max(np.abs(ya - yb))))
print('all 65536 rows bit-exact:', exact, 'max abs diff:', mx, 'sample row 1 first 4:', ya[0, 0, :4], yb[0, 0, :4])
