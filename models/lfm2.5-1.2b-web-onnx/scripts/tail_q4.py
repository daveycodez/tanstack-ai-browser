import sys, onnx
m=onnx.load(sys.argv[1], load_external_data=False)
for i,n in enumerate(m.graph.node):
    io=list(n.input)+list(n.output)
    if any('logits' in x or 'final_norm' in x for x in io): print(i, n.name, n.op_type, list(n.input), list(n.output), [onnx.helper.printable_attribute(a) for a in n.attribute])
print('nodes',len(m.graph.node),'last',m.graph.node[-1].name)
print([ (x.name, x.type.tensor_type.elem_type, [d.dim_param or d.dim_value for d in x.type.tensor_type.shape.dim]) for x in m.graph.input])
print([ (x.name, x.type.tensor_type.elem_type, [d.dim_param or d.dim_value for d in x.type.tensor_type.shape.dim]) for x in m.graph.output])
print('value_info logits*:', [ (x.name, x.type.tensor_type.elem_type, [d.dim_param or d.dim_value for d in x.type.tensor_type.shape.dim]) for x in m.graph.value_info if 'logits' in x.name or 'final_norm' in x.name])
locs=set(); ninl=0
for t in m.graph.initializer:
    if t.data_location==1: locs.add([e.value for e in t.external_data if e.key=='location'][0])
    else: ninl+=1
print('ext locations',locs,'inline inits',ninl,'total',len(m.graph.initializer))
