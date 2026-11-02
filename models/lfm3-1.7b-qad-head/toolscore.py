"""Tool score of a running llama-server on one or more prompt sets, the same way as packages/webgl/bench/tool-ref/llama_ref.py:
P(first reply token = <tool_call>) from the top-50 logprobs, whether greedy picks it first, and a 48-token greedy reply
(counted as "never calls" when <tool_call> isn't among its tokens).
usage: toolscore.py <port> <sets dir> <out.json> [lang ...]     (sets dir holds <lang>/tool_prompts.json, from mltools.py)"""
import json, sys, os, math, urllib.request

port, D, outp = sys.argv[1:4]
langs = sys.argv[4:] or sorted(os.listdir(D))
STEPS = 48


def post(path, body):
    r = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=900))


res = {}
for lang in langs:
    m = json.load(open(os.path.join(D, lang, "tool_prompts.json")))
    tc = m["tool_call_id"]
    rows = []
    for i, p in enumerate(m["prompts"]):
        r = post("/completion", {"prompt": p["ids"], "n_predict": STEPS, "temperature": 0, "top_k": 1, "n_probs": 50, "cache_prompt": False,
                                 "return_tokens": True, "samplers": ["top_k"]})
        first = r["completion_probabilities"][0]
        ptc = next((math.exp(c["logprob"]) for c in first["top_logprobs"] if c["id"] == tc), 0.0)
        top = first["top_logprobs"][0]["id"]
        toks = r.get("tokens") or []
        rows.append({"i": i, "p": ptc, "greedy": top == tc, "called": tc in toks, "reply": r["content"][:200]})
    s = {"mean_p": sum(x["p"] for x in rows) / len(rows), "greedy": sum(x["greedy"] for x in rows),
         "never": sum(not x["called"] for x in rows), "n": len(rows), "rows": rows}
    res[lang] = s
    print(f"{lang}: mean P {s['mean_p']:.3f}  greedy {s['greedy']}/{s['n']}  never-call {s['never']}", flush=True)
json.dump(res, open(outp, "w"), ensure_ascii=False, indent=1)
