import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lm import LM, load_tok, generate
tokdir, model, outp = sys.argv[1:4]
tok, render = load_tok(tokdir)
P = ['What is the capital of France? Answer in one sentence.',
     'Write a Python function that returns the n-th Fibonacci number iteratively.',
     'Explain in three short bullet points why the sky looks blue.',
     'Give me a two-day itinerary for a first visit to Kyoto.']
lm = LM(model); res = []
for p in P:
    ids = tok.encode(render([{'role': 'user', 'content': p}]), add_special_tokens=False).ids
    toks, _ = generate(lm, ids, 50)
    res.append({'prompt': p, 'ids': ids, 'traj': toks})
json.dump(res, open(outp, 'w'))
