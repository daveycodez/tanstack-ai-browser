"""Trim LFM3's byte-level BPE vocabulary to V rows (specials kept) and write a consistent tokenizer.
usage: vocab_trim.py <dl dir> <calib.json> <test_chats.json> <V> <outdir>
Writes outdir/{tokenizer.json, tokenizer_config.json, special_tokens_map.json, chat_template.jinja,
config.json, generation_config.json, keep_ids.json (old ids in new order), report.json}."""
import sys, os, json, collections, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jinja2, re
from tokenizers import Tokenizer
import corpus
dl, calib, test_chats, V, outdir = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
os.makedirs(outdir, exist_ok=True)
tj = json.load(open(os.path.join(dl, 'tokenizer.json')))
tok = Tokenizer.from_file(os.path.join(dl, 'tokenizer.json'))
vocab = tj['model']['vocab']; merges = tj['model']['merges']
merges = [m if isinstance(m, list) else m.split(' ') for m in merges]
specials = tj['added_tokens']; NS = len(specials)
id2tok = {i: t for t, i in vocab.items()}

tmpl = re.sub(r'\{%-?\s*(end)?generation\s*-?%\}', '', open(os.path.join(dl, 'chat_template.jinja')).read())
env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True)
env.filters['tojson'] = lambda v, **k: json.dumps(v, ensure_ascii=False)
def raise_exception(m): raise Exception(m)
T = env.from_string(tmpl)
render_full = lambda msgs, tools: T.render(messages=msgs, tools=tools, bos_token='<|startoftext|>', add_generation_prompt=False, raise_exception=raise_exception)

C = corpus.build(dl, calib, '/opt/homebrew/opt/python@3.15/Frameworks/Python.framework/Versions/3.15/lib/python3.15',
                 os.path.join(os.path.dirname(os.path.dirname(dl)), 'venv/lib/python3.14/site-packages'),
                 os.path.join(os.path.dirname(os.path.dirname(dl)), 'nodetest/node_modules'), render_full, tok)
C['english_chat']['test'] = json.load(open(test_chats))
for k, v in C.items(): print(f'{k:14s} train {sum(map(len, v["train"]))/1e6:6.2f} MB ({len(v["train"])} docs)  test {sum(map(len, v["test"]))/1e6:6.2f} MB ({len(v["test"])} docs)', flush=True)

# --- count ---
cnt = collections.Counter()
for k, v in C.items():
    w = 1.0 if k not in ('english_chat', 'tool_calls') else 20.0   # small but important sets weigh more
    for enc in tok.encode_batch(v['train'], add_special_tokens=False):
        for i in enc.ids: cnt[i] += w
parent = {}
for a, b in merges:
    parent.setdefault(a + b, (a, b))
R = V - NS
keep = set()
def add(t):
    st = [t]
    while st:
        x = st.pop()
        if x in keep: continue
        keep.add(x)
        if x in parent: st.extend(parent[x])
base = [t for t in vocab if len(t) == 1]
for t in base: add(t)
order = [i for i, _ in sorted(((i, c) for i, c in cnt.items() if i < len(id2tok)), key=lambda x: (-x[1], x[0]))]
seen_regular = len(order)
MINC = float(os.environ.get('MINCOUNT', '0'))
for i in order:
    if len(keep) >= R: break
    if cnt[i] >= MINC: add(id2tok[i])
n_from_counts = len(keep)
def _b2u():
    bs = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256)); cs = bs[:]; n = 0
    for b in range(256):
        if b not in bs: bs.append(b); cs.append(256 + n); n += 1
    return {chr(c): b for b, c in zip(bs, cs)}
U2B = _b2u()
is_ascii = lambda t: all(U2B.get(ch, 255) < 128 for ch in t)
for pas in (lambda t: is_ascii(t), lambda t: cnt.get(vocab[t], 0) > 0, lambda t: True):   # ASCII tokens by merge rank first, then the rest
    for i in range(len(id2tok)):
        if len(keep) >= R: break
        if pas(id2tok[i]): add(id2tok[i])
# closure may overshoot by a few: drop the highest-id never-seen leaves
if len(keep) > R:
    needed = set()
    for t in keep:
        if t in parent: needed.update(parent[t])
    for i in range(len(id2tok) - 1, -1, -1):
        t = id2tok[i]
        if len(keep) <= R: break
        if t in keep and t not in needed and cnt.get(i, 0) == 0 and len(t) > 1: keep.discard(t)
assert len(keep) == R, (len(keep), R)
kept_old = sorted(vocab[t] for t in keep)
old2new = {o: n for n, o in enumerate(kept_old)}
for j, s in enumerate(specials): old2new[s['id']] = R + j
keep_ids = kept_old + [s['id'] for s in specials]

# --- write tokenizer.json ---
new = json.loads(json.dumps(tj))
new['model']['vocab'] = {id2tok[o]: n for n, o in enumerate(kept_old)}
fmt_list = isinstance(tj['model']['merges'][0], list)
nm = [m for m in merges if m[0] in keep and m[1] in keep and (m[0] + m[1]) in keep]
new['model']['merges'] = nm if fmt_list else [' '.join(m) for m in nm]
for s in new['added_tokens']: s['id'] = old2new[s['id']]
json.dump(new, open(os.path.join(outdir, 'tokenizer.json'), 'w'), ensure_ascii=False)
for f in ['tokenizer_config.json', 'special_tokens_map.json', 'chat_template.jinja']: shutil.copy(os.path.join(dl, f), outdir)
cfg = json.load(open(os.path.join(dl, 'config.json')))
for k in ['bos_token_id', 'eos_token_id', 'pad_token_id']: cfg[k] = old2new[cfg[k]]
cfg['vocab_size'] = V
json.dump(cfg, open(os.path.join(outdir, 'config.json'), 'w'), indent=2)
gc = json.load(open(os.path.join(dl, 'generation_config.json')))
for k in ['bos_token_id', 'pad_token_id']: gc[k] = old2new[gc[k]]
gc['eos_token_id'] = [old2new[x] for x in gc['eos_token_id']]
json.dump(gc, open(os.path.join(outdir, 'generation_config.json'), 'w'), indent=2)
json.dump(keep_ids, open(os.path.join(outdir, 'keep_ids.json'), 'w'))

# --- verify on held-out sets ---
ntok = Tokenizer.from_file(os.path.join(outdir, 'tokenizer.json'))
new2old = {n: o for o, n in old2new.items()}
rep = {'V': V, 'regular_kept': R, 'merges_kept': len(nm), 'merges_orig': len(merges),
       'distinct_regular_tokens_seen_in_selection_corpus': seen_regular, 'kept_after_count_pass': n_from_counts}
print(json.dumps(rep), flush=True)
for k, v in C.items():
    docs = v['test'] or v['train'][-20:]
    a = tok.encode_batch(docs, add_special_tokens=False); b = ntok.encode_batch(docs, add_special_tokens=False)
    same_docs = 0; old_n = 0; new_n = 0; rt = 0; diff_tok = 0
    for d, x, y in zip(docs, a, b):
        ym = [new2old[i] for i in y.ids]
        same_docs += ym == x.ids; old_n += len(x.ids); new_n += len(y.ids)
        rt += ntok.decode(y.ids, skip_special_tokens=False) == tok.decode(x.ids, skip_special_tokens=False)
        # tokens of the original encoding that are no longer in the vocab
        diff_tok += sum(1 for i in x.ids if i not in old2new)
    rep[k] = {'docs': len(docs), 'identical_docs_pct': round(100 * same_docs / len(docs), 2),
              'orig_tokens': old_n, 'new_tokens': new_n, 'extra_tokens_pct': round(100 * (new_n - old_n) / old_n, 4),
              'orig_tokens_dropped_from_vocab_pct': round(100 * diff_tok / old_n, 4), 'roundtrip_identical_pct': round(100 * rt / len(docs), 2),
              'source': 'held-out' if v['test'] else 'selection set (no held-out)'}
    print(k, rep[k], flush=True)
# multilingual probe (not a target)
ml = ["El rápido zorro marrón salta sobre el perro perezoso.", "Der schnelle braune Fuchs springt über den faulen Hund.",
      "Le renard brun rapide saute par-dessus le chien paresseux.", "敏捷的棕色狐狸跳过了懒狗。", "素早い茶色の狐が怠け者の犬を飛び越える。",
      "Быстрая коричневая лиса прыгает через ленивую собаку.", "빠른 갈색 여우가 게으른 개를 뛰어넘는다."]
rep['multilingual_probe'] = [{'text': t[:20], 'orig_tokens': len(tok.encode(t).ids), 'new_tokens': len(ntok.encode(t).ids)} for t in ml]
print(rep['multilingual_probe'])
json.dump(rep, open(os.path.join(outdir, 'report.json'), 'w'), indent=1)
