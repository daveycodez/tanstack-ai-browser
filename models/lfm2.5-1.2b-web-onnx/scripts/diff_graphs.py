import sys, onnx
from onnx import helper, numpy_helper
def load(p): return onnx.load(p, load_external_data=False)
def vi(v):
    t=v.type.tensor_type
    dims=[d.dim_param or d.dim_value for d in t.shape.dim] if t.HasField('shape') else None
    return (v.name, onnx.TensorProto.DataType.Name(t.elem_type), dims)
def nodekey(n): return (n.name,n.op_type,tuple(n.input),tuple(n.output),tuple(onnx.helper.printable_attribute(a) for a in n.attribute), n.domain)
a,b=load(sys.argv[1]),load(sys.argv[2])
for lbl,m in (('A',a),('B',b)):
    print(lbl,'ir',m.ir_version,'opsets',[(o.domain,o.version) for o in m.opset_import],'producer',m.producer_name,m.producer_version,'nodes',len(m.graph.node),'inits',len(m.graph.initializer),'meta',[(p.key,p.value) for p in m.metadata_props], 'gname', m.graph.name, 'doc', m.doc_string[:80])
ia=[vi(x) for x in a.graph.input]; ib=[vi(x) for x in b.graph.input]
print('inputs only A:',[x for x in ia if x not in ib]); print('inputs only B:',[x for x in ib if x not in ia])
print('input order A names:', [x[0] for x in ia][:6], '... total', len(ia))
print('input order B names:', [x[0] for x in ib][:6], '... total', len(ib))
oa=[vi(x) for x in a.graph.output]; ob=[vi(x) for x in b.graph.output]
print('outputs only A:',[x for x in oa if x not in ob]); print('outputs only B:',[x for x in ob if x not in oa])
print('output order same:', [x[0] for x in oa]==[x[0] for x in ob])
na={nodekey(n):i for i,n in enumerate(a.graph.node)}; nb={nodekey(n):i for i,n in enumerate(b.graph.node)}
print('nodes only A:'); [print('  ',i,k) for k,i in sorted(na.items(),key=lambda x:x[1]) if k not in nb]
print('nodes only B:'); [print('  ',i,k) for k,i in sorted(nb.items(),key=lambda x:x[1]) if k not in na]
def initkey(t):
    ext={e.key:e.value for e in t.external_data}
    return (t.name,t.data_type,tuple(t.dims),t.data_location, tuple(sorted(ext.items())), t.raw_data if not ext else b'')
ia2={t.name:initkey(t) for t in a.graph.initializer}; ib2={t.name:initkey(t) for t in b.graph.initializer}
print('inits only A:',[ (k,ia2[k][:4]) for k in ia2 if k not in ib2])
print('inits only B:',[ (k,ib2[k][:4]) for k in ib2 if k not in ia2])
diff=[k for k in ia2 if k in ib2 and ia2[k]!=ib2[k]]
print('inits differing:',len(diff), diff[:10])
for k in ib2:
    if k not in ia2:
        t=[t for t in b.graph.initializer if t.name==k][0]; print('  B init',k,numpy_helper.to_array(t), t.data_type)
# order check
print('node order identical except inserted:', [n.name for n in a.graph.node]==[n.name for n in b.graph.node if n.name in {x.name for x in a.graph.node}])
print('B node positions of new nodes:', [ (i,n.name) for i,n in enumerate(b.graph.node) if nodekey(n) not in na])
vis_a={x.name:vi(x) for x in a.graph.value_info}; vis_b={x.name:vi(x) for x in b.graph.value_info}
print('value_info counts',len(vis_a),len(vis_b),'only A',[vis_a[k] for k in vis_a if k not in vis_b][:10],'only B',[vis_b[k] for k in vis_b if k not in vis_a][:10], 'diff', [ (vis_a[k],vis_b[k]) for k in vis_a if k in vis_b and vis_a[k]!=vis_b[k]][:10])
