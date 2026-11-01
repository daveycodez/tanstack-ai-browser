import sys, time
sys.path.insert(0, sys.argv[1])
from lm import LM, load_tok, generate
tok, render = load_tok(sys.argv[2])
p = render([{'role':'user','content':'What is the capital of France? Answer in one sentence.'}])
print(repr(p[-200:]))
ids = tok.encode(p, add_special_tokens=False).ids
print(len(ids), ids[:5])
t=time.time(); lm = LM(sys.argv[3]); print('load', time.time()-t)
t=time.time(); toks, _ = generate(lm, ids, 30); print('gen', time.time()-t)
print(repr(tok.decode(toks, skip_special_tokens=False)))
