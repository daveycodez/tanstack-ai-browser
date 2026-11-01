"""Token counts for the app's prompt and eval texts under two llama-servers.
usage: promptcount.py <port_full> <port_trim> <exa dir> <file...>"""
import json, sys, urllib.request

pf, pt, exa = sys.argv[1], sys.argv[2], sys.argv[3]
files = sys.argv[4:]

def post(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=600))

tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]}}
         for t in json.load(open(f"{exa}/tools.json"))]
result = open(f"{exa}/search_result.txt").read()
sysmsg = {"role": "system", "content": "The current date is Friday, October 30, 2026."}
user = {"role": "user", "content": "What has the James Webb telescope found recently?"}
call = {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "web_search_exa", "arguments": json.dumps({"query": "news article about the James Webb Space Telescope latest discoveries", "objective": "Find recent articles about new James Webb Space Telescope discoveries and summarize the key findings."})}}]}
toolmsg = {"role": "tool", "tool_call_id": "c1", "content": result}

cases = {
    "date line + Exa tools + user msg": [sysmsg, user],
    "... + tool call + Exa search result": [sysmsg, user, call, toolmsg],
}

def count(port, text):
    return len(post(port, "/tokenize", {"content": text, "add_special": False, "parse_special": True})["tokens"])

for name, msgs in cases.items():
    prompt = post(pf, "/apply-template", {"messages": msgs, "tools": tools})["prompt"]
    prompt2 = post(pt, "/apply-template", {"messages": msgs, "tools": tools})["prompt"]
    assert prompt == prompt2
    a, b = count(pf, prompt), count(pt, prompt)
    print(f"{name:40s} chars={len(prompt):6d} full={a:6d} trim={b:6d} growth={100*(b/a-1):+.1f}%")
    if name.startswith("date"):
        open("/dev/stderr", "w").write(prompt[:3000] + "\n")
r_full, r_trim = count(pf, result), count(pt, result)
print(f"{'Exa result text alone':40s} chars={len(result):6d} full={r_full:6d} trim={r_trim:6d} growth={100*(r_trim/r_full-1):+.1f}%")
for f in files:
    t = open(f).read()
    a, b = count(pf, t), count(pt, t)
    print(f"{f.split('/')[-1]:40s} chars={len(t):6d} full={a:6d} trim={b:6d} growth={100*(b/a-1):+.1f}%")
