"""Calibration text for the importance matrix: English (WikiText-2 train + chat, the previous build's cal-mix.txt),
random Wikipedia intros in all 16 languages (at most N tokens each), BF16 chat replies in 15 languages, and the 8 tool-call
transcripts of models/lfm3-1.7b-web-onnx/q4f16/scripts/corpus.py rendered with LFM3's template (special tokens as text:
run llama-imatrix with --parse-special). None of it overlaps the evaluation sets.
usage: mkcal.py <tokenizer dir> <cal-mix.txt> <wikical dir> <cal-mlchat.txt> <out> [max tokens per wiki language]"""
import sys, os, json, re, glob, jinja2
from tokenizers import Tokenizer

H = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(H, "..", "lfm3-1.7b-web-onnx", "q4f16", "scripts"))
import corpus

tokdir, calmix, wikidir, mlchat, out = sys.argv[1:6]
cap = int(sys.argv[6]) if len(sys.argv) > 6 else 8000
tok = Tokenizer.from_file(os.path.join(tokdir, "tokenizer.json"))
tmpl = re.sub(r'\{%-?\s*(end)?generation\s*-?%\}', '', open(os.path.join(tokdir, "chat_template.jinja")).read())
env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True); env.filters['tojson'] = lambda v, **k: json.dumps(v, ensure_ascii=False)
T = env.from_string(tmpl)
render = lambda msgs, tools: T.render(messages=msgs, tools=tools, bos_token='', add_generation_prompt=False, enable_thinking=False)
parts = [("english cal-mix", open(calmix, encoding="utf-8").read())]
for f in sorted(glob.glob(os.path.join(wikidir, "*.txt"))):
    keep, n = [], 0
    for para in open(f, encoding="utf-8").read().split("\n\n"):
        k = len(tok.encode(para).ids)
        if n + k > cap:
            break
        keep.append(para); n += k
    parts.append((f"wiki {os.path.basename(f)}", "\n\n".join(keep)))
parts.append(("ml chat", open(mlchat, encoding="utf-8").read()))
tt = corpus.tool_transcripts(render)
parts.append(("tool transcripts", "\n".join(tt["train"] + tt["test"])))
with open(out, "w", encoding="utf-8") as fo:
    for name, text in parts:
        fo.write(text.strip() + "\n\n")
        print(f"{name}: {len(tok.encode(text).ids)} tokens")
