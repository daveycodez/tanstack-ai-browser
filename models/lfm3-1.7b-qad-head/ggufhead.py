"""Swap the tied token embedding / LM head (token_embd.weight) of a GGUF, and check that nothing else changed.

usage:
  ggufhead.py <gguf-py dir> src    <qad.gguf> <bf16.gguf> <out.gguf>     BF16 file with token_embd = QAD's Q6_K dequantized to F32
  ggufhead.py <gguf-py dir> splice <qad.gguf> <donor.gguf> <out.gguf>    QAD file with token_embd taken from donor (type and bytes)
  ggufhead.py <gguf-py dir> verify <qad.gguf> <variant.gguf>             SHA-256 of every tensor and every KV; all but token_embd must match
  ggufhead.py <gguf-py dir> cmp    <bf16.gguf> <qad.gguf> <fresh-q6k.gguf> [more.gguf ...]   how close the embeddings are
"""
import sys, hashlib, numpy as np
sys.path.insert(0, sys.argv[1])
import gguf
from gguf.quants import dequantize

EMB = "token_embd.weight"


def copy(reader, out, replace):
    """Write reader's KVs and tensors to out, in the same order; replace[name] = (np array, GGMLQuantizationType)."""
    arch = reader.fields[gguf.Keys.General.ARCHITECTURE].contents()
    align = reader.fields.get("general.alignment")
    w = gguf.GGUFWriter(out, arch=arch)
    if align is not None:
        w.data_alignment = align.contents()
    for f in reader.fields.values():
        if f.name == gguf.Keys.General.ARCHITECTURE or f.name.startswith("GGUF."):
            continue
        vt = f.types[0]
        st = f.types[-1] if vt == gguf.GGUFValueType.ARRAY else None
        w.add_key_value(f.name, f.contents(), vt, sub_type=st)
    data = []
    for t in reader.tensors:
        if t.name in replace:
            arr, qt = replace[t.name]
        else:
            arr, qt = t.data, t.tensor_type
        w.add_tensor_info(t.name, arr.shape, arr.dtype, arr.nbytes, qt)
        data.append(arr)
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_ti_data_to_file()
    for arr in data:
        w.write_tensor_data(arr)
    w.close()


def tensor(reader, name):
    return next(t for t in reader.tensors if t.name == name)


def as_f32(t):
    if t.tensor_type == gguf.GGMLQuantizationType.F32:
        return np.asarray(t.data, dtype=np.float32).reshape(-1, t.shape[0])
    return dequantize(np.asarray(t.data), t.tensor_type).reshape(-1, int(t.shape[0])).astype(np.float32)


def kv_digest(f):
    h = hashlib.sha256()
    for i in f.data:
        h.update(bytes(np.asarray(f.parts[i]).tobytes()))
    return h.hexdigest()


cmd = sys.argv[2]
if cmd == "src":
    qad, bf16, out = sys.argv[3:6]
    e = as_f32(tensor(gguf.GGUFReader(qad), EMB))
    copy(gguf.GGUFReader(bf16), out, {EMB: (np.ascontiguousarray(e), gguf.GGMLQuantizationType.F32)})
elif cmd == "splice":
    qad, donor, out = sys.argv[3:6]
    d = tensor(gguf.GGUFReader(donor), EMB)
    copy(gguf.GGUFReader(qad), out, {EMB: (np.asarray(d.data), d.tensor_type)})
elif cmd == "verify":
    a, b = gguf.GGUFReader(sys.argv[3]), gguf.GGUFReader(sys.argv[4])
    ka = {f.name: kv_digest(f) for f in a.fields.values() if not f.name.startswith("GGUF.")}
    kb = {f.name: kv_digest(f) for f in b.fields.values() if not f.name.startswith("GGUF.")}
    bad = [k for k in set(ka) | set(kb) if ka.get(k) != kb.get(k)]
    ta = {t.name: t for t in a.tensors}
    tb = {t.name: t for t in b.tensors}
    assert list(ta) == list(tb), "tensor order/names differ"
    same = 0
    for n in ta:
        if n == EMB:
            continue
        x, y = ta[n], tb[n]
        assert x.tensor_type == y.tensor_type and list(x.shape) == list(y.shape), n
        if hashlib.sha256(np.asarray(x.data).tobytes()).digest() == hashlib.sha256(np.asarray(y.data).tobytes()).digest():
            same += 1
        else:
            bad.append(n)
    e = tb[EMB]
    print(f"verify: {same}/{len(ta) - 1} other tensors byte-identical, KVs differing: {[k for k in bad if k not in ta] or 'none'}, "
          f"tensors differing: {[k for k in bad if k in ta] or 'none'}; token_embd {e.tensor_type.name} {e.n_bytes} bytes "
          f"sha256 {hashlib.sha256(np.asarray(e.data).tobytes()).hexdigest()[:16]}")
    sys.exit(1 if bad else 0)
elif cmd == "cmp":
    files = sys.argv[3:]
    ref = as_f32(tensor(gguf.GGUFReader(files[0]), EMB)).astype(np.float64)
    embs = {f.rsplit("/", 1)[-1]: as_f32(tensor(gguf.GGUFReader(f), EMB)).astype(np.float64) for f in files[1:]}
    rn = np.linalg.norm(ref)
    rown = np.linalg.norm(ref, axis=1)

    def stats(name, x, y, yname):
        d = x - y
        rel = np.linalg.norm(d) / np.linalg.norm(y)
        rowrel = np.linalg.norm(d, axis=1) / np.maximum(np.linalg.norm(y, axis=1), 1e-12)
        cos = (x * y).sum(1) / np.maximum(np.linalg.norm(x, axis=1) * np.linalg.norm(y, axis=1), 1e-12)
        print(f"{name:34s} vs {yname:28s} rel.err {rel:.5f}  row rel.err median {np.median(rowrel):.5f} p99 {np.percentile(rowrel, 99):.5f}  "
              f"cos min {cos.min():.5f}  max|d| {np.abs(d).max():.5f}  identical rows {(np.abs(d).max(1) == 0).mean()*100:.2f}%")

    names = list(embs)
    for n in names:
        stats(n, embs[n], ref, "BF16")
    for i, n in enumerate(names):
        for m in names[i + 1:]:
            stats(n, embs[n], embs[m], m)
    # Does QAD look like Q6_K of BF16 plus noise, or like a moved embedding? Project QAD-BF16 onto fresh-BF16.
    q, f = embs[names[0]] - ref, embs[names[1]] - ref
    print(f"cos(QAD-BF16, fresh-BF16) = {(q * f).sum() / np.linalg.norm(q) / np.linalg.norm(f):.4f}; "
          f"||QAD-BF16||/||fresh-BF16|| = {np.linalg.norm(q) / np.linalg.norm(f):.3f}")
    # Row-norm and mean shifts
    print(f"row-norm ratio QAD/BF16: median {np.median(np.linalg.norm(embs[names[0]], axis=1) / np.maximum(rown, 1e-12)):.5f}; "
          f"mean vector |QAD mean - BF16 mean| / |BF16 mean| {np.linalg.norm(embs[names[0]].mean(0) - ref.mean(0)) / np.linalg.norm(ref.mean(0)):.4f}")
else:
    sys.exit(__doc__)
