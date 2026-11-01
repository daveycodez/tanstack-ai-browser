import json, sys, collections, re
rows = json.load(open(sys.argv[1]))
G = collections.defaultdict(lambda: [0,0,collections.Counter()])
def role(name, cons):
    ops = {c[0] for c in cons}
    n = name.lower()
    if 'embed' in n: return 'embedding'
    if 'lm_head' in n: return 'lm_head'
    if 'MatMulNBits' in ops:
        if re.search(r'conv', n): r='conv matmuls'
        elif re.search(r'attn|self_attn|q_proj|k_proj|v_proj|o_proj|qkv', n): r='attention matmuls'
        elif re.search(r'mlp|feed|ff|w1|w2|w3|gate|up_proj|down', n): r='MLP matmuls'
        else: r='other matmuls'
        return r
    if ops & {'SimplifiedLayerNormalization','SkipSimplifiedLayerNormalization'} or 'norm' in n: return 'norms'
    if 'CausalConvWithState' in ops: return 'conv kernels'
    return 'other'
for r in rows:
    name, dt, dims, sz, off, cons = r
    k = role(name, cons)
    part = 'w' if name.endswith(('MatMul.weight','_Q4','quant')) or dt=='UINT8' and (len(dims)==3 or 'zero' not in name) else 'x'
    G[k][0]+=sz; G[k][1]+=1; G[k][2][dt]+=sz
tot = sum(v[0] for v in G.values())
for k,v in sorted(G.items(), key=lambda x:-x[1][0]):
    print(f"{k:20s} n={v[1]:4d} {v[0]/1e6:9.2f} MB  {v[0]/tot*100:5.1f}%  ", {a:round(b/1e6,2) for a,b in v[2].items()})
print("total", tot/1e6)
