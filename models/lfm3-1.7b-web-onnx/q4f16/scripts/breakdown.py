import sys, onnx, collections, re
from onnx import helper, TensorProto
m = onnx.load(sys.argv[1], load_external_data=False); g=m.graph
size={}
for t in g.initializer:
    d={e.key:e.value for e in t.external_data}
    size[t.name]=int(d['length']) if t.data_location==TensorProto.EXTERNAL else len(t.raw_data)
dt={t.name:TensorProto.DataType.Name(t.data_type) for t in g.initializer}
shp={t.name:list(t.dims) for t in g.initializer}
def role(n):
    nm=n.name.lower()+' '+n.input[1].lower()
    if 'lm_head' in nm: return 'lm_head'
    if 'conv' in nm: 
        return 'conv.in_proj' if 'in_proj' in nm else ('conv.out_proj' if 'out_proj' in nm else 'conv.?')
    if 'attn' in nm:
        for k in ['q_proj','k_proj','v_proj','out_proj','o_proj']:
            if k in nm: return 'attn.'+k
        return 'attn.?'
    for k in ['w1','w2','w3','gate','up','down']:
        if k in nm: return 'mlp.'+k
    return '?'
G=collections.defaultdict(lambda: collections.Counter())
seen=set()
for n in g.node:
    if n.op_type!='MatMulNBits': continue
    a={x.name:helper.get_attribute_value(x) for x in n.attribute}
    r=role(n)
    c=G[r]; c['count']+=1; c['params']+=a['K']*a['N']; c['K']=a['K']; c['N']=a['N']
    for i,lab in zip(range(1,4),['qweight','scales','zp']):
        if i<len(n.input) and n.input[i] in size and n.input[i] not in seen:
            seen.add(n.input[i]); c[lab]+=size[n.input[i]]
    if len(n.input)>3 and n.input[3]: c['has_zp']+=1
    if r=='?': print('unknown', n.name, n.input[1])
print(f"{'role':16s}{'n':>4s}{'K':>6s}{'N':>8s}{'Mparams':>9s}{'qweight MB':>12s}{'scales MB':>11s}{'zp MB':>8s}{'total MB':>10s} zp?")
tot=collections.Counter()
for r,c in sorted(G.items()):
    t=c['qweight']+c['scales']+c['zp']
    print(f"{r:16s}{c['count']:4d}{c['K']:6d}{c['N']:8d}{c['params']/1e6:9.1f}{c['qweight']/1e6:12.2f}{c['scales']/1e6:11.2f}{c['zp']/1e6:8.2f}{t/1e6:10.2f} {c['has_zp']}")
    for k in ['params','qweight','scales','zp']: tot[k]+=c[k]
print('matmul totals', {k:round(v/1e6,2) for k,v in tot.items()})
# one example of names
for n in g.node:
    if n.op_type in('MatMulNBits',) and ('layers.2.' in n.name or 'layers.0.' in n.name): print(n.name, list(n.input))
for n in g.node:
    if n.op_type=='GatherBlockQuantized': print(n.name, list(n.input))
    if n.op_type=='GroupQueryAttention': 
        print(n.name, list(n.input), {x.name:helper.get_attribute_value(x) for x in n.attribute}); break
