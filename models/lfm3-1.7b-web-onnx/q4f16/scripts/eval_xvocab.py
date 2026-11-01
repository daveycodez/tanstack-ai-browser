"""Quality eval that works across vocabularies. Reference = fp16 with the original tokenizer.
usage: eval_xvocab.py <S> <out.json> label=model.cpu.onnx@tokdir[@keep_ids.json] ...
  wiki:  NLL over the same 16 WikiText-2 test text chunks (each model uses its own tokenizer),
         reported as perplexity per ORIGINAL token (comparable to earlier numbers) + bits/char.
  chat:  6 prompts, fp16 greedy 64 tokens, teacher-forced; top-1 agreement and KL(fp16 || model) on the
         shared token space (fp16 renormalized over kept tokens), plus fp16 mass on dropped tokens."""
import sys, os, json, numpy as np, pyarrow.parquet as pq
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lm as L
from tokenizers import Tokenizer
S, outp = sys.argv[1], sys.argv[2]
specs = []
for a in sys.argv[3:]:
    lab, rest = a.split('=', 1); parts = rest.split('@')
    specs.append((lab, os.path.join(S, parts[0]), os.path.join(S, parts[1]), os.path.join(S, parts[2]) if len(parts) > 2 else None))
otok = Tokenizer.from_file(S + '/dl/tokenizer.json')
text = '\n\n'.join(pq.read_table(S + '/dl/wikitext/wikitext-2-raw-v1/test-00000-of-00001.parquet').column('text').to_pylist())
enc = otok.encode(text, add_special_tokens=False)
chunks = []
for i in range(16):
    a = enc.offsets[i * 511][0]; b = enc.offsets[(i + 1) * 511][0]
    chunks.append(text[a:b])
orig_ntok = 16 * 511; nchar = sum(map(len, chunks))
PROMPTS = ['What is the capital of France? Answer in one sentence.',
    'Write a Python function that returns the n-th Fibonacci number iteratively.',
    'Explain in three short bullet points why the sky looks blue.',
    'Give me a two-day itinerary for a first visit to Kyoto.',
    'Summarize the plot of a heist movie you invent, in about 80 words.',
    'If a train leaves at 3:40 pm and the trip takes 2 hours 35 minutes, when does it arrive? Show your steps.']
def lsm(x): x = x.astype(np.float64); m = x.max(-1, keepdims=True); return x - m - np.log(np.exp(x - m).sum(-1, keepdims=True))
res = {}; ref = None
SK = set(json.load(open(os.environ['SKIPKEEP']))) if os.environ.get('SKIPKEEP') else None
for lab, mp, td, kp in specs:
    tok, render = L.load_tok(td)
    keep = np.array(json.load(open(kp))) if kp else None
    lm = L.LM(mp, threads=16)
    nll = 0.0
    for c in chunks:
        ids = [L.BOS] + tok.encode(c, add_special_tokens=False).ids
        feed = lm.empty_cache(); feed['input_ids'] = np.array([ids], np.int64)
        feed['attention_mask'] = np.ones((1, len(ids)), np.int64); feed['num_logits_to_keep'] = np.array(len(ids), np.int64)
        lp = lsm(lm.s.run(['logits'], feed)[0][0, :-1]); t = np.array(ids[1:])
        nll -= lp[np.arange(len(t)), t].sum()
    r = {}
    r.update({'wiki_ppl_per_orig_token': float(np.exp(nll / orig_ntok)), 'wiki_bits_per_char': float(nll / nchar / np.log(2))})
    # chat
    if ref is None:
        trajs, refl = [], []
        for p in PROMPTS:
            ids = tok.encode(render([{'role': 'user', 'content': p}]), add_special_tokens=False).ids
            toks, _ = L.generate(lm, ids, 64)
            _, lg = L.generate(lm, ids, len(toks), forced=toks)
            trajs.append((p, toks)); refl.append(np.stack(lg))
        ref = (trajs, refl, otok)
    else:
        trajs, refl, _ = ref
        o2n = {int(o): n for n, o in enumerate(keep)} if keep is not None else None
        agree = n = 0; kls = []; dropped = []; skipped = 0
        for (p, toks), R in zip(trajs, refl):
            ids = tok.encode(render([{'role': 'user', 'content': p}]), add_special_tokens=False).ids
            if o2n is not None:
                oids = otok.encode(render([{'role': 'user', 'content': p}]), add_special_tokens=False).ids
                if [int(keep[i]) for i in ids] != oids: r.setdefault('prompts_retokenized', []).append([otok.id_to_token(t) for t in oids if t not in o2n])
                upto = next((i for i, t in enumerate(toks) if t not in o2n), len(toks)); skipped += len(toks) - upto
                ft = [o2n[t] for t in toks[:upto]]
            else:
                upto = len(toks); ft = toks
            if SK is not None:
                upto = min(upto, next((i for i, t in enumerate(toks) if t not in SK), len(toks))); ft = ft[:upto]
            if upto == 0: continue
            _, lg = L.generate(lm, ids, upto, forced=ft); Q = lsm(np.stack(lg)); P = lsm(R[:upto])
            if keep is not None:
                Pk = P[:, keep]; mass = np.exp(Pk).sum(-1); dropped += list(1 - mass); Pk = Pk - np.log(mass)[:, None]
                top_ref = R[:upto].argmax(-1); top_new = keep[Q.argmax(-1)]
            else:
                Pk = P; top_ref = R[:upto].argmax(-1); top_new = Q.argmax(-1); dropped += [0.0] * upto
            kls += list((np.exp(Pk) * (Pk - Q)).sum(-1)); agree += int((top_ref == top_new).sum()); n += upto
        r.update({'chat_top1_vs_fp16': 100 * agree / n, 'chat_KL_fp16': float(np.mean(kls)), 'chat_steps': n,
                  'chat_steps_skipped_dropped_token': skipped, 'fp16_mass_on_dropped_tokens': float(np.mean(dropped))})
    res[lab] = r; print(lab, json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in r.items()}), flush=True)
    del lm
json.dump(res, open(outp, 'w'), indent=1)
