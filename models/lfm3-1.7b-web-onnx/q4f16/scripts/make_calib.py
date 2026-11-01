"""Build calibration token sequences: WikiText-2 *train* chunks + chat transcripts
sampled from the fp16 model (prompts differ from the eval prompts)."""
import sys, os, json, numpy as np, pyarrow.parquet as pq
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lm import LM, load_tok
tokdir, trainpq, fp16, outp = sys.argv[1:5]
rng = np.random.default_rng(0)
tok, render = load_tok(tokdir)
text = '\n\n'.join(pq.read_table(trainpq).column('text').to_pylist())
ids = tok.encode(text, add_special_tokens=False).ids
seqs = []
for off in rng.choice(len(ids) - 600, 48, replace=False):
    seqs.append([124894] + ids[off:off + 511])
PROMPTS = [
 "How do I make a sourdough starter from scratch?", "Write a haiku about winter mornings.",
 "Explain the difference between TCP and UDP.", "What are some tips for a job interview at a startup?",
 "Translate 'Where is the train station?' into Spanish, French and German.", "Write a short story about a robot learning to paint.",
 "How does compound interest work? Give an example.", "Write a JavaScript function that debounces another function.",
 "What causes the seasons on Earth?", "Draft a polite email asking my landlord to fix the heating.",
 "Compare electric cars and hybrid cars for city driving.", "Explain recursion to a ten-year-old.",
 "List five healthy breakfast ideas with ingredients.", "What is the difference between a virus and a bacterium?",
 "Write a SQL query that finds the top three customers by total order value.", "Give me a weekly workout plan for a beginner.",
 "Why do cats purr?", "Summarize the main ideas of stoicism.", "How do I center a div in CSS?",
 "Write a limerick about a forgetful wizard.", "Explain how a bill becomes a law in the United States.",
 "What should I pack for a week in Iceland in October?", "Write a Rust function that reverses a string.",
 "Explain what a neural network is in simple terms.", "Plan a birthday party for a seven-year-old on a small budget.",
 "What are the pros and cons of working from home?", "Describe the water cycle step by step.",
 "Write a product description for a reusable water bottle.", "How can I improve my sleep?",
 "Explain the Pythagorean theorem with an example.", "Write a dialogue between a detective and a suspect.",
 "Give me a recipe for vegetable curry.", "Was ist der Unterschied zwischen 'seit' und 'seitdem'?",
 "¿Cuáles son los planetas del sistema solar?", "Rewrite this sentence to be more formal: 'gonna be late, traffic is nuts'.",
 "What is the time complexity of quicksort and why?", "Write a bash script that renames all .txt files to .md.",
 "Give three arguments for and against school uniforms.", "How do vaccines train the immune system?",
 "Write a motivational message for someone starting a new job.",
]
lm = LM(fp16, threads=16)
for p in PROMPTS:
    pid = tok.encode(render([{'role': 'user', 'content': p}]), add_special_tokens=False).ids
    cache = lm.empty_cache(); logits, cache = lm.step(pid, cache, len(pid)); out = []
    total = len(pid)
    for _ in range(320):
        z = logits / 0.7; z = np.exp(z - z.max()); z /= z.sum()
        t = int(rng.choice(len(z), p=z)); out.append(t)
        if t == 124900: break
        total += 1; logits, cache = lm.step([t], cache, total)
    seqs.append(pid + out)
    print(len(seqs), len(out), repr(tok.decode(out)[:80]), flush=True)
json.dump(seqs, open(outp, 'w'))
print('seqs', len(seqs), 'tokens', sum(map(len, seqs)))
