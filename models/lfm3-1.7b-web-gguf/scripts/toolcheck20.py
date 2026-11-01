"""20 search-worthy prompts with the app's setup (date line + Exa tools). Counts direct, well-formed tool calls.
usage: toolcheck20.py <port> <exa dir> <think 0|1>"""
import json, sys, urllib.request

port, exa, think = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
URL = f"http://127.0.0.1:{port}/v1/chat/completions"
tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]}}
         for t in json.load(open(f"{exa}/tools.json"))]
P = """What's the latest news about SpaceX Starship?
Who won the most recent Formula 1 race?
Search the web for reviews of the Pixel 10 Pro camera.
What is the current price of Bitcoin?
Find me recent articles about AI regulation in the EU.
What's the weather forecast for London this weekend?
Look up the opening hours of the Louvre museum.
What are people saying about the new Nintendo console?
Read this page and summarize it: https://en.wikipedia.org/wiki/Large_language_model
Find the official documentation for TanStack Query v5.
What happened in the stock market today?
Search for the best-rated ramen restaurants in Tokyo.
Who is the current CEO of OpenAI?
Find recent research papers on quantization of language models.
What are the newest features in Firefox for Android?
Look up the release date of the next Zelda game.
What is the population of Lagos in 2026?
Find a tutorial on building a Chrome extension with TypeScript.
What did the latest IPCC report say about sea level rise?
Get the content of https://huggingface.co/LiquidAI/LFM3-1.7B and tell me what the model is good at.""".strip().split("\n")

ok = 0; strict = 0; bad = []
for p in P:
    body = {"messages": [{"role": "system", "content": "The current date is Friday, October 30, 2026."}, {"role": "user", "content": p}],
            "tools": tools, "temperature": 0, "max_tokens": 1024 if think else 300, "chat_template_kwargs": {"enable_thinking": think}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    m = json.load(urllib.request.urlopen(req, timeout=600))["choices"][0]["message"]
    tc = m.get("tool_calls") or []
    good = False
    if tc:
        f = tc[0]["function"]
        try:
            args = json.loads(f["arguments"])
            if f["name"] == "web_search_exa":
                good = bool(args.get("query")); strict += good and bool(args.get("objective"))
            elif f["name"] == "web_fetch_exa":
                good = bool(args.get("urls")); strict += good
        except Exception:
            pass
    ok += good
    if not good:
        bad.append((p[:40], (m.get("content") or "")[:80].replace("\n", " "), [t["function"]["name"] for t in tc]))
print(f"direct tool calls: {ok}/{len(P)}  with all required args: {strict}/{len(P)}")
for b in bad:
    print("  miss:", b)
