import sys, os, json, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lm as L, jinja2, corpus
S = sys.argv[1]
Q = ["What's the weather in Paris right now?", "Search the web for the latest SpaceX launch.",
     "Add 'Call mom' to my calendar tomorrow at 6pm.", "Use Python to compute 37 factorial."]
for lab, model, td in [x.split('=') for x in sys.argv[2:]]:
    tok, _ = L.load_tok(os.path.join(S, td))
    tmpl = re.sub(r'\{%-?\s*(end)?generation\s*-?%\}', '', open(os.path.join(S, td, 'chat_template.jinja')).read())
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True); env.filters['tojson'] = lambda v, **k: json.dumps(v, ensure_ascii=False)
    T = env.from_string(tmpl); lm = L.LM(os.path.join(S, model)); outs = []
    for q in Q:
        p = T.render(messages=[{'role': 'user', 'content': q}], tools=corpus.TOOLS, bos_token='<|startoftext|>', add_generation_prompt=True, enable_thinking=False)
        ids = tok.encode(p, add_special_tokens=False).ids
        toks, _ = L.generate(lm, ids, 80)
        outs.append(tok.decode(toks, skip_special_tokens=False))
    print('##', lab); [print('  ', repr(o)) for o in outs]
