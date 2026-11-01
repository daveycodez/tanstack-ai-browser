import sys, json
from transformers import AutoTokenizer
repo, out = sys.argv[1], sys.argv[2]
tok = AutoTokenizer.from_pretrained(repo)
doc = open(f"{repo}/chat_template.jinja").read() + "\n\n" + open(f"{repo}/LICENSE").read()
res = {}
for n in (4000, 8000):
    body = doc
    while len(tok(body, add_special_tokens=False)["input_ids"]) < n: body += "\n\n" + doc
    ids = tok(body, add_special_tokens=False)["input_ids"][:n]
    text = tok.apply_chat_template([{"role": "user", "content": "Summarize this:\n\n" + tok.decode(ids)}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    res[f"long{n}"] = {"ids": tok(text, add_special_tokens=False)["input_ids"]}
    print(n, len(res[f"long{n}"]["ids"]))
json.dump(res, open(out, "w"))
