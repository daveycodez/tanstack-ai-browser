# Compares the q4 graph's standard-op embedding lookup against com.microsoft GatherBlockQuantized
# (onnxruntime CPU) and against a numpy reference, for all 49,152 token ids.
import sys, onnx, numpy as np, onnxruntime as ort
from onnx import helper, numpy_helper, TensorProto
q4 = onnx.load(sys.argv[1], load_external_data=True)
g = q4.graph
P = "/model/embed_tokens/dq/"
sub_nodes = [n for n in g.node if n.name.startswith(P)]
inits = {t.name: t for t in g.initializer}
need = {i for n in sub_nodes for i in n.input if i in inits}
emb3 = numpy_helper.to_array(inits["model_embed_tokens_weight_quant"]); sc = numpy_helper.to_array(inits["model_embed_tokens_weight_scales"]); zp = numpy_helper.to_array(inits["model_embed_tokens_weight_zp"])
emb2 = emb3.reshape(emb3.shape[0], -1)
gbq = helper.make_node("GatherBlockQuantized", ["emb2", "input_ids", "model_embed_tokens_weight_scales", "model_embed_tokens_weight_zp"], ["ref"], domain="com.microsoft", bits=4, block_size=32, gather_axis=0, quantize_axis=1)
out_name = [n for n in sub_nodes if n.name == P + "out"][0].output[0]
graph = helper.make_graph(sub_nodes + [gbq], "emb",
    [helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["b", "s"])],
    [helper.make_tensor_value_info(out_name, TensorProto.FLOAT, None), helper.make_tensor_value_info("ref", TensorProto.FLOAT, None)],
    [inits[n] for n in need] + [numpy_helper.from_array(emb2, "emb2")])
m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 21), helper.make_opsetid("com.microsoft", 1)], ir_version=10)
s = ort.InferenceSession(m.SerializeToString(), providers=["CPUExecutionProvider"])
ids = np.arange(emb3.shape[0], dtype=np.int64).reshape(4, -1)
mine, ref = s.run(None, {"input_ids": ids})
# numpy reference: low nibble = even element, high nibble = odd element; zp packed the same way per block
q = np.stack([emb2 & 15, emb2 >> 4], -1).reshape(emb2.shape[0], -1, 32).astype(np.float32)
z = np.stack([zp & 15, zp >> 4], -1).reshape(zp.shape[0], -1, 1).astype(np.float32)
npref = ((q - z) * sc[..., None]).reshape(emb2.shape[0], -1)
mine = mine.reshape(-1, mine.shape[-1]); ref = ref.reshape(-1, ref.shape[-1])
print("shape", mine.shape, "bit-identical to GatherBlockQuantized:", np.array_equal(mine.view(np.uint32), ref.view(np.uint32)),
      "| to numpy:", np.array_equal(mine, npref), "| max abs diff vs GBQ:", float(np.abs(mine - ref).max()))
