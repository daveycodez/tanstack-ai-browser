"""Trim an LFM3 GGUF to the daveycodez/LFM3-1.7B-Web vocabulary.

usage: trimvocab.py <gguf-py dir> <in.gguf> <tokenizer.json> <out.gguf>
"""
import json, sys
sys.path.insert(0, sys.argv[1])
import numpy as np
import gguf

src, tokjson, dst = sys.argv[2], sys.argv[3], sys.argv[4]
r = gguf.GGUFReader(src)
old_tokens = r.fields["tokenizer.ggml.tokens"].contents()
old_types = r.fields["tokenizer.ggml.token_type"].contents()
old_id = {t: i for i, t in enumerate(old_tokens)}
assert len(old_id) == len(old_tokens), "duplicate token strings in source"

t = json.load(open(tokjson))
new = {}
for s, i in t["model"]["vocab"].items():
    new[i] = s
for a in t["added_tokens"]:
    assert a["id"] not in new
    new[a["id"]] = a["content"]
n = len(new)
assert sorted(new) == list(range(n)), "new ids not contiguous"
new_tokens = [new[i] for i in range(n)]
missing = [s for s in new_tokens if s not in old_id]
assert not missing, f"tokens not in source vocab: {missing[:10]}"
keep = np.array([old_id[s] for s in new_tokens], dtype=np.int64)  # new id -> old id
new_types = [int(old_types[o]) for o in keep]
merges = [" ".join(m) if isinstance(m, list) else m for m in t["model"]["merges"]]
for m in merges[:2000]:
    a, b = m.split(" ")
    assert a in old_id and b in old_id and (a + b) in old_id

def remap(key):
    f = r.fields.get(key)
    if f is None:
        return None
    old = int(f.contents())
    s = old_tokens[old]
    nid = new_tokens.index(s)
    print(f"{key}: {old} ({s}) -> {nid}")
    return nid

special_keys = [k for k in r.fields if k.startswith("tokenizer.ggml.") and k.endswith("_token_id")]
new_special = {k: remap(k) for k in special_keys}

arch = r.fields["general.architecture"].contents()
w = gguf.GGUFWriter(dst, arch=arch, endianess=r.endianess)
TOK = {"tokenizer.ggml.tokens", "tokenizer.ggml.token_type", "tokenizer.ggml.merges", "tokenizer.ggml.scores"}
for f in r.fields.values():
    if f.name == gguf.Keys.General.ARCHITECTURE or f.name.startswith("GGUF.") or f.name in TOK:
        continue
    vt = f.types[0]
    st = f.types[-1] if vt == gguf.GGUFValueType.ARRAY else None
    val = new_special[f.name] if f.name in new_special else f.contents()
    w.add_key_value(f.name, val, vt, sub_type=st)
w.add_token_list(new_tokens)
w.add_token_types(new_types)
w.add_token_merges(merges)
if "tokenizer.ggml.scores" in r.fields:
    sc = r.fields["tokenizer.ggml.scores"].contents()
    w.add_token_scores([sc[o] for o in keep])

def tdata(tensor):
    d = tensor.data
    if tensor.name == "token_embd.weight" or (tensor.name == "output.weight"):
        assert d.shape[0] == len(old_tokens), (tensor.name, d.shape)
        d = np.ascontiguousarray(d[keep])
    return d

datas = {}
for tensor in r.tensors:
    d = tdata(tensor)
    datas[tensor.name] = d
    w.add_tensor_info(tensor.name, d.shape, d.dtype, d.nbytes, tensor.tensor_type)
w.write_header_to_file()
w.write_kv_data_to_file()
w.write_ti_data_to_file()
for tensor in r.tensors:
    w.write_tensor_data(datas[tensor.name], tensor_endianess=r.endianess)
w.close()
print("wrote", dst, "vocab", n, "merges", len(merges))
