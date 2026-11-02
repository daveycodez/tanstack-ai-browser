"""Chat replies from a running llama-server (BF16), as "User: …\n\nAssistant: …" text, thinking off, temperature 0.7.
usage:
  genchat.py <port> eval <out dir>          prompts/chat_prompts_ml.json: native prompts, one file per language (evaluation)
  genchat.py <port> cal <prompts.txt> <out>  English prompts with "Answer in <language>." rotated over 15 languages (calibration)
"""
import json, sys, os, urllib.request

H = os.path.dirname(os.path.abspath(__file__))
port, mode = sys.argv[1], sys.argv[2]
URL = f"http://127.0.0.1:{port}/v1/chat/completions"
NAMES = {"es": "Spanish", "de": "German", "fr": "French", "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
         "ko": "Korean", "ar": "Arabic", "ru": "Russian", "hi": "Hindi", "vi": "Vietnamese", "th": "Thai", "id": "Indonesian", "pl": "Polish"}


def reply(p, seed):
    body = {"messages": [{"role": "user", "content": p}], "temperature": 0.7, "seed": seed, "max_tokens": 450,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return (json.load(urllib.request.urlopen(req, timeout=600))["choices"][0]["message"].get("content") or "").strip()


if mode == "eval":
    out = sys.argv[3]; os.makedirs(out, exist_ok=True)
    for lang, ps in json.load(open(os.path.join(H, "prompts", "chat_prompts_ml.json"))).items():
        with open(os.path.join(out, f"{lang}.txt"), "w", encoding="utf-8") as fo:
            for i, p in enumerate(ps):
                fo.write(f"User: {p}\n\nAssistant: {reply(p, 2000 + i)}\n\n")
        print(lang, "done", flush=True)
elif mode == "cal":
    P = [l for l in open(sys.argv[3]).read().strip().split("\n") if l]
    langs = list(NAMES)
    with open(sys.argv[4], "w", encoding="utf-8") as fo:
        for i, p in enumerate(P):
            q = f"{p} Answer in {NAMES[langs[i % len(langs)]]}."
            fo.write(f"User: {q}\n\nAssistant: {reply(q, 3000 + i)}\n\n")
            print(i, flush=True)
else:
    sys.exit(__doc__)
