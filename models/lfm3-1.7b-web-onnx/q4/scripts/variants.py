# Test-only variants of the q4 graph (share the same data file): acc0 = MatMulNBits accuracy_level 0; nowin = no sliding window (negative control)
import sys, onnx
src, out_acc0, out_nowin = sys.argv[1:4]
m = onnx.load(src, load_external_data=False)
for n in m.graph.node:
    if n.op_type == "MatMulNBits":
        for a in n.attribute:
            if a.name == "accuracy_level": a.i = 0
onnx.save(m, out_acc0)
m = onnx.load(src, load_external_data=False)
for n in m.graph.node:
    if n.op_type == "GroupQueryAttention":
        for a in n.attribute:
            if a.name == "local_window_size" and a.i == 256: a.i = -1
onnx.save(m, out_nowin)
