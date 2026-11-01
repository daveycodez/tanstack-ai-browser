"""Build a smaller LFM3 q4f16 graph.
  --rope N         truncate cos/sin rotary caches to N positions (lossless for sequences <= N)
  --bs B           requantize MatMulNBits (and the shared embedding/lm_head) to block size B
                   from the fp16 source weights, asymmetric 4-bit with per-block clip search
  --keep-fused     leave gate/up/q/k/v projections untouched (bs32 symmetric) so ORT WebGPU's
                   fused MLP/QKV decode kernels still apply
Writes <out>/model_q4f16.onnx + <out>/model_q4f16.onnx_data."""
import argparse, os, sys, numpy as np, onnx, time
from onnx import helper, TensorProto
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qlib import ExtReader, quantize, gptq
import json

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True); ap.add_argument('--fp16', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--rope', type=int, default=0); ap.add_argument('--bs', type=int, default=0)
ap.add_argument('--keep-fused', action='store_true'); ap.add_argument('--no-embed', action='store_true')
ap.add_argument('--embed-bs', type=int, default=0); ap.add_argument('--rtn', action='store_true')
ap.add_argument('--roles', default='', help='comma list of name substrings to requantize (default: all)')
ap.add_argument('--embed-only', action='store_true')
ap.add_argument('--gptq', default='', help='dir with H/*.npy + map.json from collect_h.py; use GPTQ instead of RTN')
ap.add_argument('--fused-sym32', action='store_true', help='with --gptq: requantize gate/up/q/k/v as symmetric bs32 (no zp) so WebGPU fused kernels still apply')
a = ap.parse_args()
CLIP = (1.0,) if a.rtn else tuple(np.linspace(1.0, 0.7, 13))
ROLES = [r for r in a.roles.split(',') if r]
HMAP = json.load(open(os.path.join(a.gptq, 'map.json'))) if a.gptq else None
src = ExtReader(a.src); f16 = ExtReader(a.fp16) if (a.bs or a.embed_bs) else None
m = src.m; g = m.graph
new_arrays = {}       # name -> np array (replaces / adds initializer)
new_dims = {}
FUSED = ('gate_proj', 'up_proj', 'q_proj', 'k_proj', 'v_proj')
t0 = time.time()

if a.rope:
    for nm in ['cos_cache_global', 'sin_cache_global', 'cos_cache_local', 'sin_cache_local']:
        new_arrays[nm] = np.ascontiguousarray(src.get(nm)[:a.rope])

def setattr_(node, key, val):
    for at in node.attribute:
        if at.name == key: at.i = val; return
    node.attribute.append(helper.make_attribute(key, val))

if a.bs or a.embed_bs:
    bs = a.bs or a.embed_bs
    for n in g.node:
        if a.embed_only: break
        if n.op_type != 'MatMulNBits' or n.name.startswith('/lm_head'): continue
        if ROLES and not any(r in n.name for r in ROLES): continue
        is_fused = any(f in n.name for f in FUSED)
        if a.keep_fused and is_fused and not a.fused_sym32: continue
        at = {x.name: helper.get_attribute_value(x) for x in n.attribute}
        N, K = at['N'], at['K']
        wname = n.name.replace('/MatMul_Quant', '/MatMul').strip('/').replace('/', '.').replace('.MatMul', '.MatMul.weight')
        W = f16.get(wname).astype(np.float32).T
        assert W.shape == (N, K), (wname, W.shape)
        nbs, asym = (32, False) if (a.fused_sym32 and is_fused) else (bs, True)
        if HMAP is not None:
            qw, s, z = gptq(W, np.load(os.path.join(a.gptq, HMAP[wname])), nbs, asym, CLIP)
        else:
            qw, s, z = quantize(W, nbs, asym, CLIP)
        new_arrays[n.input[1]] = qw; new_arrays[n.input[2]] = s
        if not asym:
            del n.input[3:]
            setattr_(n, 'block_size', nbs)
            print(f'{n.name} N={N} K={K} sym{nbs} done {time.time()-t0:.0f}s', flush=True)
            continue
        zname = n.input[3] if len(n.input) > 3 and n.input[3] else n.input[1].replace('_quant', '_zp')
        new_arrays[zname] = z
        while len(n.input) < 4: n.input.append('')
        n.input[3] = zname
        setattr_(n, 'block_size', bs)
        print(f'{n.name} N={N} K={K} done {time.time()-t0:.0f}s', flush=True)
    bs = a.embed_bs or bs
    if not a.no_embed:
        E = f16.get('model.embed_tokens.weight').astype(np.float32)  # [V, H]
        V, H = E.shape
        qw, s, z = quantize(E, bs, True, CLIP)
        new_arrays['model_embed_tokens_weight_quant'] = qw.reshape(V, H // 2)
        new_arrays['model_embed_tokens_weight_scales'] = s
        new_arrays['model_embed_tokens_weight_zp'] = z
        new_arrays['model_embed_tokens_weight_quant_matmul_shape'] = np.array([V, H // bs, bs // 2], np.int64)
        for n in g.node:
            if n.op_type == 'GatherBlockQuantized' and 'embed_tokens' in n.input[0]: setattr_(n, 'block_size', bs)
            if n.op_type == 'MatMulNBits' and n.name.startswith('/lm_head'): setattr_(n, 'block_size', bs)
        print('embedding done', flush=True)

# --- write new external data file ---
os.makedirs(a.out, exist_ok=True)
data_name = 'model_q4f16.onnx_data'
existing = {t.name for t in g.initializer}
for nm, arr in new_arrays.items():
    if nm not in existing:
        g.initializer.append(onnx.numpy_helper.from_array(arr, nm))
off = 0
with open(os.path.join(a.out, data_name), 'wb') as fo:
    for t in g.initializer:
        arr = new_arrays.get(t.name)
        if arr is None: arr = src.get(t.name)
        arr = np.ascontiguousarray(arr).reshape(np.shape(arr))
        dt = onnx.helper.np_dtype_to_tensor_dtype(arr.dtype)
        b = arr.tobytes()
        t.ClearField('raw_data'); t.ClearField('float_data'); t.ClearField('int64_data'); t.ClearField('int32_data')
        del t.dims[:]; t.dims.extend(arr.shape); t.data_type = dt
        if len(b) < 1024:  # small tensors stay inline (shape inference needs them)
            t.data_location = TensorProto.DEFAULT; del t.external_data[:]; t.raw_data = b
            continue
        pad = (-off) % 64
        fo.write(b'\0' * pad); off += pad
        fo.write(b)
        t.data_location = TensorProto.EXTERNAL
        del t.external_data[:]
        for k, v in [('location', data_name), ('offset', str(off)), ('length', str(len(b)))]:
            e = t.external_data.add(); e.key = k; e.value = v
        off += len(b)
onnx.save(m, os.path.join(a.out, 'model_q4f16.onnx'))
print('wrote', a.out, 'data bytes', off, f'({off/1e6:.1f} MB)', f'{time.time()-t0:.0f}s')
