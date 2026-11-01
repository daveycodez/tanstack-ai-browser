"""Move external tensors < 1 KB back inline in a graph (for graphs built before that fix)."""
import sys, os, numpy as np, onnx
from onnx import TensorProto
p = sys.argv[1]; d = os.path.dirname(p)
m = onnx.load(p, load_external_data=False); k = 0
for t in m.graph.initializer:
    if t.data_location != TensorProto.EXTERNAL: continue
    e = {x.key: x.value for x in t.external_data}
    if int(e['length']) >= 1024: continue
    with open(os.path.join(d, e['location']), 'rb') as f:
        f.seek(int(e.get('offset', 0))); b = f.read(int(e['length']))
    t.data_location = TensorProto.DEFAULT; del t.external_data[:]; t.raw_data = b; k += 1
onnx.save(m, p); print('inlined', k, p)
