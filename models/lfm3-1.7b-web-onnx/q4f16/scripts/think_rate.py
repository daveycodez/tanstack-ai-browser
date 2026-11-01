import sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lm import LM, load_tok
S = sys.argv[1]; tok, render = load_tok(S + '/dl')
th = tok.token_to_id('<think>'); print('think id', th)
P = ["Write a short poem about the ocean.", "What's 17 times 23?", "Suggest a name for a coffee shop.", "How do I boil an egg?",
     "Write a function in Go that checks if a number is prime.", "What is the boiling point of water in Fahrenheit?",
     "Give me three tips for learning guitar.", "Explain blockchain in two sentences.", "Write a thank-you note to a teacher.",
     "What are the main causes of inflation?", "Invent a riddle and give the answer.", "How far is the Moon from Earth?",
     "Write a regex that matches an email address.", "Describe a sunset to someone who has never seen one.",
     "What's a good stretching routine for desk workers?", "Solve: 2x + 7 = 19.", "Name five famous paintings and their painters.",
     "Write a tweet announcing a new bakery opening.", "What does HTTP status 418 mean?", "Plan a three-course vegetarian dinner."]
for label in sys.argv[2:]:
    n, p = label.split('=')
    lm = LM(S + '/' + p); probs = []; top = 0
    for q in P:
        ids = tok.encode(render([{'role': 'user', 'content': q}]), add_special_tokens=False).ids
        lg, _ = lm.step(ids, lm.empty_cache(), len(ids))
        pr = np.exp(lg - lg.max()); pr /= pr.sum(); probs.append(pr[th]); top += int(lg.argmax() == th)
    print(f'{n:15s} mean P(<think> first)={np.mean(probs):.3f}  max={np.max(probs):.3f}  greedy picks <think> in {top}/{len(P)}')
