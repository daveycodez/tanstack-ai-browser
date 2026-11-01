import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lm import LM, load_tok, generate
tokdir, model, outp = sys.argv[1:4]
tok, render = load_tok(tokdir)
P = ["How do I make cold brew coffee at home?", "Explain the difference between a list and a tuple in Python.",
 "Write a short bedtime story about a brave little turtle.", "What are good ways to save money on groceries?",
 "Give me a packing checklist for a beach vacation.", "How does a refrigerator keep food cold?",
 "Write an email declining a meeting politely.", "What's the difference between weather and climate?",
 "Suggest five names for a golden retriever puppy.", "How can I get better at public speaking?",
 "Write a TypeScript interface for a blog post with tags and an author.", "Explain what an API is with an analogy.",
 "What should I know before adopting a cat?", "Summarize the causes of World War I briefly.",
 "Write a SQL statement to create a users table with email and created_at.", "How do I remove a stripped screw?",
 "Describe how to brew green tea properly.", "What's a healthy way to start running if I'm out of shape?",
 "Write a short motivational speech for a soccer team at halftime.", "Explain what DNS does when I type a website name.",
 "Give me a recipe for banana bread.", "How do noise-cancelling headphones work?",
 "Write a git command sequence to create a branch, commit, and push.", "What are the symptoms of dehydration?",
 "Explain the rules of chess for the knight and the bishop.", "Write a regex to validate a US ZIP code and explain it.",
 "Plan a one-week study schedule for a calculus exam.", "Why do leaves change color in autumn?",
 "Write a React component that shows a counter with a button.", "What are some fun indoor activities for a rainy day?"]
lm = LM(model, threads=16); out = []
for p in P:
    msgs = [{'role': 'user', 'content': p}]
    ids = tok.encode(render(msgs), add_special_tokens=False).ids
    toks, _ = generate(lm, ids, 220)
    out.append(tok.decode(ids + toks, skip_special_tokens=False))
json.dump(out, open(outp, 'w')); print(len(out), 'chats', sum(map(len, out)), 'chars')
