"""P(first assistant token = <tool_call>) over 20 tool-worthy prompts (thinking off), and greedy-pick rate."""
import sys, os, json, re, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lm as L, jinja2, corpus
S = sys.argv[1]
Q = ["What's the weather in Paris right now?", "Search the web for the latest SpaceX launch.", "Add 'Call mom' to my calendar tomorrow at 6pm.",
     "Use Python to compute 37 factorial.", "Is it raining in Seattle?", "Find news about the Mars rover.", "Look up who won the last World Cup.",
     "Schedule a dentist appointment on Friday at 9am.", "How hot is it in Phoenix today, in Fahrenheit?", "Run code to print the first 20 primes.",
     "Search for reviews of the new iPhone.", "Put 'Team standup' on my calendar every weekday at 10am starting Monday.", "What's the temperature in Tokyo?",
     "Compute the SHA-256 of the string hello using Python.", "Search the web for cheap flights from Boston to Lisbon.", "Weather in Cape Town please.",
     "Find the population of Canada online.", "Book 'Lunch with Sam' tomorrow at 12:30 for an hour.", "Use Python to sort [5, 3, 9, 1] and print it.",
     "Search for the best pizza places in Naples."]
for lab, model, td in [x.split('=') for x in sys.argv[2:]]:
    tok, _ = L.load_tok(os.path.join(S, td)); tc = tok.token_to_id('<tool_call>')
    tmpl = re.sub(r'\{%-?\s*(end)?generation\s*-?%\}', '', open(os.path.join(S, td, 'chat_template.jinja')).read())
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True); env.filters['tojson'] = lambda v, **k: json.dumps(v, ensure_ascii=False)
    T = env.from_string(tmpl); lm = L.LM(os.path.join(S, model)); ps = []; top = 0
    for q in Q:
        p = T.render(messages=[{'role': 'user', 'content': q}], tools=corpus.TOOLS, bos_token='<|startoftext|>', add_generation_prompt=True, enable_thinking=False)
        ids = tok.encode(p, add_special_tokens=False).ids
        lg, _ = lm.step(ids, lm.empty_cache(), len(ids)); pr = np.exp(lg - lg.max()); pr /= pr.sum()
        ps.append(pr[tc]); top += int(lg.argmax() == tc)
    print(f'{lab:10s} mean P(<tool_call> first)={np.mean(ps):.3f}  greedy direct tool call {top}/{len(Q)}', flush=True)
