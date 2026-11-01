import numpy as np, onnx, os
from onnx import TensorProto, helper
NP = {TensorProto.FLOAT16: np.float16, TensorProto.FLOAT: np.float32, TensorProto.UINT8: np.uint8, TensorProto.INT64: np.int64}

class ExtReader:
    """Read initializers lazily from external data via memmap."""
    def __init__(self, model_path):
        self.dir = os.path.dirname(model_path)
        self.m = onnx.load(model_path, load_external_data=False)
        self.t = {t.name: t for t in self.m.graph.initializer}
        self.mm = {}
    def get(self, name):
        t = self.t[name]
        dt = NP[t.data_type]
        if t.data_location == TensorProto.EXTERNAL:
            d = {e.key: e.value for e in t.external_data}
            loc = os.path.join(self.dir, d['location'])
            if loc not in self.mm: self.mm[loc] = np.memmap(loc, np.uint8, 'r')
            off, ln = int(d.get('offset', 0)), int(d['length'])
            return np.frombuffer(self.mm[loc][off:off + ln].tobytes(), dt).reshape(tuple(t.dims))
        return onnx.numpy_helper.to_array(t)

def unpack4(b):  # uint8 [..., n] -> uint8 [..., 2n], low nibble first
    out = np.empty(b.shape[:-1] + (b.shape[-1] * 2,), np.uint8)
    out[..., 0::2] = b & 0x0F; out[..., 1::2] = b >> 4
    return out
def pack4(q):
    q = q.astype(np.uint8)
    return (q[..., 0::2] | (q[..., 1::2] << 4)).astype(np.uint8)

def dequant(qw, scales, zp, N, K, bs):
    """MatMulNBits layout -> fp32 [N, K]"""
    nb = (K + bs - 1) // bs
    q = unpack4(qw.reshape(N, nb, bs // 2)).astype(np.float32)
    s = scales.reshape(N, nb, 1).astype(np.float32)
    if zp is None: z = 8.0
    else: z = unpack4(zp.reshape(N, -1))[:, :nb].reshape(N, nb, 1).astype(np.float32)
    return ((q - z) * s).reshape(N, nb * bs)[:, :K]

def quantize(W, bs, asym=True, clip=(1.0,), chunk=4096):
    """W fp32 [N, K] -> (qweight uint8 [N, nb, bs/2], scales fp16 [N, nb], zp uint8 [N, ceil(nb/2)] or None).
    Round-to-nearest per block; optional per-block grid search over range shrink factors (min MSE)."""
    N, K = W.shape
    assert K % bs == 0
    nb = K // bs
    Q = np.empty((N, nb, bs), np.uint8); S = np.empty((N, nb), np.float16); Z = np.empty((N, nb), np.uint8)
    for r0 in range(0, N, chunk):
        w = W[r0:r0 + chunk].reshape(-1, nb, bs).astype(np.float32)
        best_err = None
        for c in clip:
            if asym:
                mn = np.minimum(w.min(-1), 0) * c; mx = np.maximum(w.max(-1), 0) * c
                s = ((mx - mn) / 15.0).astype(np.float16)
                sf = s.astype(np.float32); sf[sf == 0] = 1.0
                z = np.clip(np.round(-mn / sf), 0, 15)
                q = np.clip(np.round(w / sf[..., None] + z[..., None]), 0, 15)
                deq = (q - z[..., None]) * s.astype(np.float32)[..., None]
            else:
                am = np.abs(w).max(-1); idx = np.abs(w).argmax(-1)
                mxv = np.take_along_axis(w, idx[..., None], -1)[..., 0] * c
                s = (mxv / -8.0).astype(np.float16)
                sf = s.astype(np.float32); sf[sf == 0] = 1.0
                z = np.full(s.shape, 8.0)
                q = np.clip(np.round(w / sf[..., None] + 8), 0, 15)
                deq = (q - 8) * s.astype(np.float32)[..., None]
            err = ((deq - w) ** 2).sum(-1)
            if best_err is None:
                best_err = err; bq, bs_, bz = q, s, z
            else:
                m = err < best_err
                best_err = np.where(m, err, best_err)
                bq = np.where(m[..., None], q, bq); bs_ = np.where(m, s, bs_); bz = np.where(m, z, bz)
        Q[r0:r0 + chunk] = bq; S[r0:r0 + chunk] = bs_; Z[r0:r0 + chunk] = bz
    qweight = pack4(Q)  # [N, nb, bs/2]
    zp = None
    if asym:
        zz = Z if nb % 2 == 0 else np.concatenate([Z, np.zeros((N, 1), np.uint8)], 1)
        zp = pack4(zz)
    return qweight, S, zp

def _group_params(w, asym, clip):
    """w [N, g] -> (scale fp16 [N], zp float [N]) choosing per-row clip with min MSE."""
    best = None
    for c in clip:
        if asym:
            mn = np.minimum(w.min(-1), 0) * c; mx = np.maximum(w.max(-1), 0) * c
            s = ((mx - mn) / 15.0).astype(np.float16); sf = s.astype(np.float32); sf[sf == 0] = 1.0
            z = np.clip(np.round(-mn / sf), 0, 15)
        else:
            idx = np.abs(w).argmax(-1); mxv = w[np.arange(len(w)), idx] * c
            s = (mxv / -8.0).astype(np.float16); sf = s.astype(np.float32); sf[sf == 0] = 1.0
            z = np.full(len(w), 8.0)
        q = np.clip(np.round(w / sf[:, None] + z[:, None]), 0, 15)
        err = (((q - z[:, None]) * s.astype(np.float32)[:, None] - w) ** 2).sum(-1)
        if best is None: best = [err, s, z]
        else:
            m = err < best[0]
            best = [np.where(m, err, best[0]), np.where(m, s, best[1]), np.where(m, z, best[2])]
    return best[1], best[2]

def gptq(W, H, gs, asym=True, clip=(1.0,), blocksize=128, percdamp=0.01):
    """GPTQ (no act-order) with per-group params fixed when the group starts.
    W fp32 [N, K]; H fp32 [K, K] (mean X^T X). Returns same tuple as quantize()."""
    W = W.astype(np.float32).copy(); N, K = W.shape
    H = H.astype(np.float64).copy()
    dead = np.diag(H) == 0
    H[dead, dead] = 1; W[:, dead] = 0
    H[np.diag_indices(K)] += percdamp * np.mean(np.diag(H))
    Hinv = np.linalg.inv(H)
    U = np.linalg.cholesky(Hinv).T.astype(np.float32)  # Hinv = U^T U, U upper
    nb = K // gs
    Q = np.zeros((N, K), np.uint8); S = np.zeros((N, nb), np.float16); Z = np.zeros((N, nb), np.float32)
    assert blocksize % gs == 0
    for i1 in range(0, K, blocksize):
        i2 = min(i1 + blocksize, K); W1 = W[:, i1:i2].copy(); E1 = np.zeros_like(W1)
        U1 = U[i1:i2, i1:i2]
        for i in range(i2 - i1):
            col = i1 + i
            if col % gs == 0:
                s, z = _group_params(W1[:, i:i + gs], asym, clip)
                S[:, col // gs] = s; Z[:, col // gs] = z
                sf = s.astype(np.float32); sf[sf == 0] = 1.0; zf = z
            w = W1[:, i]
            q = np.clip(np.round(w / sf + zf), 0, 15)
            Q[:, col] = q
            dq = (q - zf) * s.astype(np.float32)
            err = (w - dq) / U1[i, i]
            W1[:, i:] -= np.outer(err, U1[i, i:])
            E1[:, i] = err
        W[:, i2:] -= E1 @ U[i1:i2, i2:]
    qweight = pack4(Q.reshape(N, nb, gs))
    Zu = Z.astype(np.uint8)
    zp = None
    if asym:
        zz = Zu if nb % 2 == 0 else np.concatenate([Zu, np.zeros((N, 1), np.uint8)], 1)
        zp = pack4(zz)
    return qweight, S, zp

# ---------------- n-bit (2/4) variants ----------------
def packn(q, bits):
    per = 8 // bits; q = q.astype(np.uint8)
    assert q.shape[-1] % per == 0
    q = q.reshape(q.shape[:-1] + (q.shape[-1] // per, per))
    out = np.zeros(q.shape[:-1], np.uint8)
    for j in range(per): out |= (q[..., j] << (bits * j)).astype(np.uint8)
    return out
def unpackn(b, bits):
    per = 8 // bits; m = (1 << bits) - 1
    out = np.empty(b.shape[:-1] + (b.shape[-1] * per,), np.uint8)
    for j in range(per): out[..., j::per] = (b >> (bits * j)) & m
    return out
def dequant_n(qw, scales, zp, N, K, bs, bits):
    nb = K // bs
    q = unpackn(qw.reshape(N, nb, bs * bits // 8), bits).astype(np.float32)
    s = scales.reshape(N, nb, 1).astype(np.float32)
    z = (2 ** (bits - 1)) if zp is None else unpackn(zp.reshape(N, -1), bits)[:, :nb].reshape(N, nb, 1).astype(np.float32)
    return ((q - z) * s).reshape(N, K)

def _group_params_n(w, bits, clip):
    maxq = (1 << bits) - 1; best = None
    for c in clip:
        mn = np.minimum(w.min(-1), 0) * c; mx = np.maximum(w.max(-1), 0) * c
        s = ((mx - mn) / maxq).astype(np.float16); sf = s.astype(np.float32); sf[sf == 0] = 1.0
        z = np.clip(np.round(-mn / sf), 0, maxq)
        q = np.clip(np.round(w / sf[:, None] + z[:, None]), 0, maxq)
        err = (((q - z[:, None]) * s.astype(np.float32)[:, None] - w) ** 2).sum(-1)
        if best is None: best = [err, s, z]
        else:
            m = err < best[0]; best = [np.where(m, err, best[0]), np.where(m, s, best[1]), np.where(m, z, best[2])]
    return best[1], best[2]

def gptq_n(W, H, gs, bits, clip=(1.0,), blocksize=128, percdamp=0.01):
    """Asymmetric n-bit GPTQ (bits in {2,4}); returns MatMulNBits (qweight, scales, zp)."""
    maxq = (1 << bits) - 1
    W = W.astype(np.float32).copy(); N, K = W.shape
    H = H.astype(np.float64).copy(); dead = np.diag(H) == 0
    H[dead, dead] = 1; W[:, dead] = 0
    H[np.diag_indices(K)] += percdamp * np.mean(np.diag(H))
    U = np.linalg.cholesky(np.linalg.inv(H)).T.astype(np.float32)
    nb = K // gs; Q = np.zeros((N, K), np.uint8); S = np.zeros((N, nb), np.float16); Z = np.zeros((N, nb), np.float32)
    blocksize = max(blocksize, gs); assert blocksize % gs == 0
    for i1 in range(0, K, blocksize):
        i2 = min(i1 + blocksize, K); W1 = W[:, i1:i2].copy(); E1 = np.zeros_like(W1); U1 = U[i1:i2, i1:i2]
        for i in range(i2 - i1):
            col = i1 + i
            if col % gs == 0:
                s, z = _group_params_n(W1[:, i:i + gs], bits, clip)
                S[:, col // gs] = s; Z[:, col // gs] = z; sf = s.astype(np.float32); sf[sf == 0] = 1.0
            w = W1[:, i]; q = np.clip(np.round(w / sf + z), 0, maxq); Q[:, col] = q
            err = (w - (q - z) * s.astype(np.float32)) / U1[i, i]
            W1[:, i:] -= np.outer(err, U1[i, i:]); E1[:, i] = err
        W[:, i2:] -= E1 @ U[i1:i2, i2:]
    per = 8 // bits
    qweight = packn(Q.reshape(N, nb, gs), bits)
    Zu = Z.astype(np.uint8); padn = (-nb) % per
    if padn: Zu = np.concatenate([Zu, np.zeros((N, padn), np.uint8)], 1)
    return qweight, S, packn(Zu, bits)
