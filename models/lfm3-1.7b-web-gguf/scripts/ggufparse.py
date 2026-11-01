import struct,sys,collections
b=open(sys.argv[1],'rb').read();o=0
def r(f):
    global o; v=struct.unpack_from(f,b,o); o+=struct.calcsize(f); return v[0]
def s():
    n=r('<Q'); global o; v=b[o:o+n].decode('utf8','replace'); o+=n; return v
def val(t):
    if t in (0,1): return r('<B' if t==0 else '<b')
    if t in (2,3): return r('<H' if t==2 else '<h')
    if t in (4,5): return r('<I' if t==4 else '<i')
    if t==6: return r('<f')
    if t==7: return r('<B')
    if t==8: return s()
    if t==9:
        at=r('<I'); n=r('<Q'); return [val(at) for _ in range(n)]
    if t in (10,11): return r('<Q' if t==10 else '<q')
    if t==12: return r('<d')
assert b[:4]==b'GGUF'; o=4; r('<I'); nt=r('<Q'); nk=r('<Q')
for _ in range(nk):
    k=s(); t=r('<I'); v=val(t)
    if not isinstance(v,list): 
        if 'lfm3' in k or 'file_type' in k: print(k,v)
T={0:'F32',1:'F16',2:'Q4_0',8:'Q8_0',10:'Q2_K',11:'Q3_K',12:'Q4_K',13:'Q5_K',14:'Q6_K',30:'BF16'}
BPW={'F32':32,'F16':16,'Q4_0':4.5,'Q8_0':8.5,'Q3_K':3.4375,'Q4_K':4.5,'Q5_K':5.5,'Q6_K':6.5625,'BF16':16}
by=collections.Counter(); names=collections.defaultdict(list)
for _ in range(nt):
    n=s(); nd=r('<I'); dims=[r('<Q') for _ in range(nd)]; t=r('<I'); r('<Q')
    ne=1
    for d in dims: ne*=d
    tn=T.get(t,str(t)); by[tn]+=ne*BPW.get(tn,0)/8
    if tn in('Q6_K','Q5_K','Q8_0','F16'): names[tn].append((n,dims))
tot=sum(by.values())
for k,v in by.most_common(): print(f"{k}: {v/1e6:.0f} MB ({100*v/tot:.1f}%)")
for k,l in names.items():
    print(k, len(l), [x[0] for x in l][:12])
