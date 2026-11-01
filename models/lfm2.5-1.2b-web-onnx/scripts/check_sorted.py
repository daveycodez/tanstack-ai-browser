# Validate a topologically sorted copy (in memory only) with the ONNX checker + shape inference.
import sys, onnx
from onnx import shape_inference
m=onnx.load(sys.argv[1], load_external_data=True)
g=m.graph
avail=set(i.name for i in g.input)|set(t.name for t in g.initializer)|{''}
nodes=list(g.node); out=[]
while nodes:
    rest=[]
    for n in nodes:
        if all(x in avail for x in n.input): out.append(n); avail.update(n.output)
        else: rest.append(n)
    assert len(rest)<len(nodes), 'cycle/missing input'
    nodes=rest
del g.node[:]; g.node.extend(out)
onnx.checker.check_model(m)
print('checker OK on topo-sorted copy')
del g.value_info[:]
inf=shape_inference.infer_shapes(m, strict_mode=True)
vi={v.name:v for v in inf.graph.value_info}
for n in ['/lm_head/num_logits_to_keep/Slice/output_0','/lm_head/num_logits_to_keep/Unsqueeze/output_0']:
    t=vi[n].type.tensor_type; print(n, onnx.TensorProto.DataType.Name(t.elem_type), [d.dim_param or d.dim_value for d in t.shape.dim])
