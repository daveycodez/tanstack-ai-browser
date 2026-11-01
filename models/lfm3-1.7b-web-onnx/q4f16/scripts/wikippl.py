"""WikiText-2 test perplexity + KL/top-1 vs an fp16 reference.
usage: wikippl.py <tokdir> <wikitext test parquet> <ref_logprobs.npy> <label> <model.onnx> [nchunks]
If ref npy does not exist, this model is treated as the reference and its log-probs are saved."""
import sys, os, json, numpy as np, pyarrow.parquet as pq
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lm import LM
from tokenizers import Tokenizer
tokdir, pqf, refp, label, path = sys.argv[1:6]
NCH = int(sys.argv[6]) if len(sys.argv) > 6 else 16; L = 512
tok = Tokenizer.from_file(tokdir + '/tokenizer.json')
text = '\n\n'.join(pq.read_table(pqf).column('text').to_pylist())
ids = tok.encode(text, add_special_tokens=False).ids
chunks = [[124894] + ids[i * L:(i + 1) * L - 1] for i in range(NCH)]
lm = LM(path, threads=8)
is_ref = not os.path.exists(refp)
ref = None if is_ref else np.load(refp, mmap_mode='r')
out = np.empty((NCH, L - 1, 128000), np.float16) if is_ref else None
nll = 0.0; n = 0; agree = 0; kl = 0.0
for c, ch in enumerate(chunks):
    feed = lm.empty_cache(); feed['input_ids'] = np.array([ch], np.int64)
    feed['attention_mask'] = np.ones((1, len(ch)), np.int64); feed['num_logits_to_keep'] = np.array(len(ch), np.int64)
    lg = lm.s.run(['logits'], feed)[0][0, :-1].astype(np.float32)
    lp = lg - (np.log(np.exp(lg - lg.max(-1, keepdims=True)).sum(-1, keepdims=True)) + lg.max(-1, keepdims=True))
    tgt = np.array(ch[1:])
    nll -= lp[np.arange(len(tgt)), tgt].sum(); n += len(tgt)
    if is_ref: out[c] = lp
    else:
        r = ref[c].astype(np.float32)
        agree += (r.argmax(-1) == lp.argmax(-1)).sum()
        kl += (np.exp(r) * (r - lp)).sum()
if is_ref: np.save(refp, out)
res = {'label': label, 'ppl': float(np.exp(nll / n)), 'tokens': n}
if not is_ref: res.update({'top1_vs_fp16': float(agree / n * 100), 'KL_fp16': float(kl / n)})
print(json.dumps(res), flush=True)
