"""Sliding-window layers: replace GQA's local_window_size with an attention bias,
so onnxruntime-web runs them with flash attention (no [heads, S, T] score buffer)."""
import sys, onnx
from onnx import helper, TensorProto, numpy_helper
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
SHIFT = int(sys.argv[3]) if len(sys.argv) > 3 else 0
m = onnx.load(src, load_external_data=False)
g = m.graph
WINDOW = None
gqa = [n for n in g.node if n.op_type == "GroupQueryAttention"]
bias_name = gqa[0].input[10]
assert all(n.input[10] == bias_name for n in gqa)
sliding = []
for n in gqa:
    a = next(a for a in n.attribute if a.name == "local_window_size")
    if a.i != -1:
        WINDOW = a.i if WINDOW is None else WINDOW
        assert a.i == WINDOW
        sliding.append(n)
print("window", WINDOW, "sliding layers", [n.name for n in sliding])

by_name = {n.name: n for n in g.node}
T1 = by_name["/model/shared_dims/attention_mask_total_seq_len_1d"].output[0]  # int64 [1] = total length T
S1 = by_name["/model/shared_dims/root_input_seq_len_1d"].output[0]            # int64 [1] = new tokens S
print("T", T1, "S", S1)
p = "/model/sliding_window_bias/"
def c(name, value, dtype):
    t = numpy_helper.from_array(np.array(value, dtype=dtype), p + name)
    g.initializer.append(t)
    return t.name
zero_axes = c("axes0", [0], np.int64)
nodes = [
    helper.make_node("Sub", [T1, S1], [p + "past_1d"], name=p + "Sub"),
    helper.make_node("Squeeze", [p + "past_1d", zero_axes], [p + "past"], name=p + "SqueezePast"),
    helper.make_node("Squeeze", [T1, zero_axes], [p + "total"], name=p + "SqueezeTotal"),
    helper.make_node("Cast", [p + "past"], [p + "past_f"], name=p + "CastPast", to=TensorProto.FLOAT),
    helper.make_node("Cast", [p + "total"], [p + "total_f"], name=p + "CastTotal", to=TensorProto.FLOAT),
    # Positions of the new (query) tokens: past .. T-1, as a column [S, 1].
    helper.make_node("Range", [p + "past_f", p + "total_f", c("one", 1.0, np.float32)], [p + "q_pos"], name=p + "RangeQ"),
    helper.make_node("Unsqueeze", [p + "q_pos", c("axes1", [1], np.int64)], [p + "q_col"], name=p + "UnsqueezeQ"),
    # Key position + window, as a row [T]: WINDOW .. T-1+WINDOW.
    helper.make_node("Add", [p + "total_f", c("window", float(WINDOW + SHIFT), np.float32)], [p + "k_end"], name=p + "AddEnd"),
    helper.make_node("Range", [c("window_start", float(WINDOW + SHIFT), np.float32), p + "k_end", c("one_k", 1.0, np.float32)], [p + "k_lim"], name=p + "RangeK"),
    # Key j is outside query p's window when j + WINDOW <= p, i.e. p - j >= WINDOW
    # (onnxruntime's local_window_size: each query sees its last WINDOW positions).
    helper.make_node("LessOrEqual", [p + "k_lim", p + "q_col"], [p + "outside"], name=p + "LessOrEqual"),
    helper.make_node("Where", [p + "outside", c("neg", np.float16(-65504.0), np.float16), bias_name], [p + "bias"], name=p + "Where"),
]
# Insert right after the node that produces the shared bias (graph stays topologically sorted).
idx = next(i for i, n in enumerate(g.node) if bias_name in n.output)
for k, n in enumerate(nodes):
    g.node.insert(idx + 1 + k, n)
for n in sliding:
    n.input[10] = p + "bias"
    for a in n.attribute:
        if a.name == "local_window_size":
            a.i = -1
# (external weights are checked by loading the model in onnxruntime)
onnx.save(m, dst)
print("saved", dst)
