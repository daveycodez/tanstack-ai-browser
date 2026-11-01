"""Convert daveycodez/LFM3-1.7B-Web model_q4f16.onnx (fp16 activations) to model_q4.onnx (fp32 activations).

- float16 initializers -> float32 (exact widening; scales, norms, rotary caches, conv weights, constants)
- uint8 initializers (packed 4-bit weights, zero points) copied byte-for-byte
- Cast(to=FLOAT16) -> Cast(to=FLOAT)
- graph inputs / outputs / value_info FLOAT16 -> FLOAT
- --sliding window: the five sliding-window GQA nodes get local_window_size=256 and the shared
  padding bias (as in onnx-community/LFM3-1.7B-ONNX); the /model/sliding_window_bias subgraph is removed.
  --sliding bias: keep the q4f16 graph's sliding-window attention bias as is.
"""
import argparse, os, sys
import numpy as np
import onnx
from onnx import TensorProto, numpy_helper, helper

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("dst_dir")
ap.add_argument("--sliding", choices=["window", "bias"], default="window")
ap.add_argument("--name", default="model_q4.onnx")
args = ap.parse_args()

src_dir = os.path.dirname(os.path.abspath(args.src))
m = onnx.load(args.src, load_external_data=True)
g = m.graph
F16, F32 = TensorProto.FLOAT16, TensorProto.FLOAT

# 1. initializers
n_conv = 0
new_inits = []
for t in g.initializer:
    if t.data_type == F16:
        a = numpy_helper.to_array(t)
        b = a.astype(np.float32)
        assert np.array_equal(b.astype(np.float16).view(np.uint16), a.view(np.uint16)) or np.isnan(a).any()
        nt = numpy_helper.from_array(b, t.name)
        new_inits.append(nt); n_conv += 1
    else:
        assert t.data_type in (TensorProto.UINT8, TensorProto.INT64, F32), (t.name, t.data_type)
        nt = TensorProto(); nt.CopyFrom(t)
        nt.ClearField("external_data"); nt.data_location = TensorProto.DEFAULT
        if t.data_location == TensorProto.EXTERNAL or t.external_data:
            raise RuntimeError("expected loaded data")
        new_inits.append(nt)
del g.initializer[:]
g.initializer.extend(new_inits)
print("converted fp16 initializers:", n_conv)

# 2. Cast nodes, and any other dtype-carrying attributes
for n in g.node:
    for a in n.attribute:
        if n.op_type == "Cast" and a.name == "to" and a.i == F16:
            a.i = F32
        if a.type == onnx.AttributeProto.TENSOR and a.t.data_type == F16:
            raise RuntimeError(f"tensor attr fp16 in {n.name}")
        if a.name in ("dtype", "to", "output_dtype") and a.type == onnx.AttributeProto.INT and a.i == F16:
            raise RuntimeError(f"fp16 dtype attr in {n.name}")

# 3. type info
def fix(vi):
    tt = vi.type.tensor_type
    if tt.elem_type == F16:
        tt.elem_type = F32
for vi in list(g.input) + list(g.output) + list(g.value_info):
    fix(vi)

# 4. sliding-window layers
sliding = [n for n in g.node if n.op_type == "GroupQueryAttention" and len(n.input) > 10 and n.input[10] == "/model/sliding_window_bias/bias"]
print("sliding GQA nodes:", [n.name for n in sliding])
assert len(sliding) == 5
if args.sliding == "window":
    for n in sliding:
        n.input[10] = "/model/gqa_attention_bias/Expand/output_0"
        for a in n.attribute:
            if a.name == "local_window_size":
                assert a.i == -1
                a.i = 256
    # drop the now-dead sliding_window_bias subgraph
    used = set()
    for n in g.node:
        used.update(n.input)
    used.update(o.name for o in g.output)
    changed = True
    nodes = list(g.node)
    while changed:
        changed = False
        keep = []
        for n in nodes:
            if n.name.startswith("/model/sliding_window_bias/") and not any(o in used for o in n.output):
                changed = True
            else:
                keep.append(n)
        nodes = keep
        used = set(); [used.update(n.input) for n in nodes]; used.update(o.name for o in g.output)
    removed_nodes = [n.name for n in g.node if n not in nodes]
    del g.node[:]; g.node.extend(nodes)
    dead_inits = [t for t in g.initializer if t.name not in used]
    print("removed nodes:", removed_nodes)
    print("removed initializers:", [t.name for t in dead_inits])
    keep_i = [t for t in g.initializer if t.name in used]
    del g.initializer[:]; g.initializer.extend(keep_i)
    names = {o for n in g.node for o in n.output}
    keep_vi = [v for v in g.value_info if v.name in names]
    del g.value_info[:]; g.value_info.extend(keep_vi)

# 5. Embedding + LM head.
#  - onnxruntime-web 1.31.1's WebGPU-enabled WASM builds (asyncify / jspi, which the app loads even for
#    device "wasm") have no CPU kernel for GatherBlockQuantized, so the 4-bit embedding lookup is rebuilt
#    from standard ops (Gather, Cast, Mul, Floor, Sub, Unsqueeze, Concat, Reshape) on the same packed bytes.
#  - onnxruntime's MatMulNBits<float> PrePack (1.31) rejects a 2-D B ([49152, 1024]); it wants
#    [N, K/32, 16]. The shared packed tensor is therefore re-declared as [49152, 64, 16] (same bytes,
#    same row-major order), which the LM head takes directly and the new lookup gathers rows from.
lm = [n for n in g.node if n.name == "/lm_head/MatMul_Quant"]
gbq = [n for n in g.node if n.op_type == "GatherBlockQuantized"]
assert len(lm) == 1 and len(gbq) == 1
lm, gbq = lm[0], gbq[0]
EMB, SC, ZP = "model_embed_tokens_weight_quant", "model_embed_tokens_weight_scales", "model_embed_tokens_weight_zp"
assert list(gbq.input) == [EMB, "input_ids", SC, ZP] and list(lm.input[1:]) == [EMB, SC, ZP]
ga = {a.name: helper.get_attribute_value(a) for a in gbq.attribute}
assert ga == {"bits": 4, "block_size": 32, "gather_axis": 0, "quantize_axis": 1}, ga
la = {a.name: helper.get_attribute_value(a) for a in lm.attribute}
N_, K_ = la["N"], la["K"]; NB = K_ // 32
emb = next(t for t in g.initializer if t.name == EMB)
assert list(emb.dims) == [N_, K_ // 2]
del emb.dims[:]; emb.dims.extend([N_, NB, 16])
zp = next(t for t in g.initializer if t.name == ZP); assert list(zp.dims) == [N_, NB // 2]
sc = next(t for t in g.initializer if t.name == SC); assert list(sc.dims) == [N_, NB]
P = "/model/embed_tokens/dq/"
def c(name, arr):
    g.initializer.append(numpy_helper.from_array(arr, P + name)); return P + name
c16 = c("c16", np.array(16.0, np.float32)); cinv = c("c1_16", np.array(0.0625, np.float32))
ax_last = c("axes_last", np.array([-1], np.int64))
sh_w = c("shape_w", np.array([0, 0, NB, 32], np.int64))
sh_z = c("shape_z", np.array([0, 0, NB, 1], np.int64))
sh_o = c("shape_o", np.array([0, 0, K_], np.int64))
nodes = []
def nd(op, ins, name, **kw):
    out = P + name
    nodes.append(helper.make_node(op, ins, [out], name=P + name, **kw)); return out
def unpack(x_u8, tag):
    # byte b holds element 2i in its low nibble and element 2i+1 in its high nibble
    xf = nd("Cast", [x_u8], tag + "_f", to=TensorProto.FLOAT)
    hi = nd("Floor", [nd("Mul", [xf, cinv], tag + "_div16")], tag + "_hi")
    lo = nd("Sub", [xf, nd("Mul", [hi, c16], tag + "_hi16")], tag + "_lo")
    return nd("Concat", [nd("Unsqueeze", [lo, ax_last], tag + "_lo_u"), nd("Unsqueeze", [hi, ax_last], tag + "_hi_u")], tag + "_pairs", axis=-1)
w = unpack(nd("Gather", [EMB, "input_ids"], "w_u8", axis=0), "w")            # [B,S,64,16,2]
w = nd("Reshape", [w, sh_w], "w_q")                                           # [B,S,64,32]
z = unpack(nd("Gather", [ZP, "input_ids"], "z_u8", axis=0), "z")             # [B,S,32,2]
z = nd("Reshape", [z, sh_z], "z_q")                                           # [B,S,64,1]
s_ = nd("Unsqueeze", [nd("Gather", [SC, "input_ids"], "s", axis=0), ax_last], "s_u")   # [B,S,64,1]
y = nd("Mul", [nd("Sub", [w, z], "w_minus_z"), s_], "w_scaled")
nodes.append(helper.make_node("Reshape", [y, sh_o], list(gbq.output), name=P + "out"))
idx = list(g.node).index(gbq)
g.node.remove(gbq)
for i, n in enumerate(nodes): g.node.insert(idx + i, n)

# sanity: no fp16 anywhere
for vi in list(g.input) + list(g.output) + list(g.value_info):
    assert vi.type.tensor_type.elem_type != F16, vi.name
for t in g.initializer:
    assert t.data_type != F16

os.makedirs(args.dst_dir, exist_ok=True)
dst = os.path.join(args.dst_dir, args.name)
loc = args.name + "_data"
for p in (dst, os.path.join(args.dst_dir, loc)):
    if os.path.exists(p): os.remove(p)
onnx.save_model(m, dst, save_as_external_data=True, all_tensors_to_one_file=True, location=loc, size_threshold=1024, convert_attribute=False)
os.chmod(dst, 0o644); os.chmod(os.path.join(args.dst_dir, loc), 0o644)  # onnx checker rejects ORT-only SimplifiedLayerNormalization (same for the source graph)
print("saved", dst)
