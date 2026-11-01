"""Assemble tokenizer-selection (train) and held-out (test) text sets by category."""
import os, json, glob, zlib, re, random
import pyarrow.parquet as pq

def _split(path):  # deterministic file-level split: ~1 in 8 files is held out
    return 'test' if zlib.crc32(path.encode()) % 8 == 0 else 'train'

def code_files(roots, exts, limit_bytes):
    out = {'train': [], 'test': []}; tot = {'train': 0, 'test': 0}
    files = []
    for r in roots:
        for e in exts: files += glob.glob(os.path.join(r, '**', '*' + e), recursive=True)
    for f in sorted(set(files)):
        try:
            s = open(f, encoding='utf-8').read()
        except Exception:
            continue
        if not s.strip() or len(s) > 400_000: continue
        if max((len(l) for l in s.splitlines()), default=0) > 1000: continue  # skip minified
        k = _split(f)
        if tot[k] > limit_bytes * (0.2 if k == 'test' else 1): continue
        out[k].append(s); tot[k] += len(s)
    return out

TOOLS = [
 {"type": "function", "function": {"name": "web_search", "description": "Search the web and return the top results.",
   "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "What to search for"}, "num_results": {"type": "integer"}}, "required": ["query"]}}},
 {"type": "function", "function": {"name": "get_weather", "description": "Get the current weather for a city.",
   "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "units": {"type": "string", "enum": ["metric", "imperial"]}}, "required": ["city"]}}},
 {"type": "function", "function": {"name": "create_calendar_event", "description": "Create an event in the user's calendar.",
   "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "start": {"type": "string", "description": "ISO 8601 date-time"}, "duration_minutes": {"type": "integer"}}, "required": ["title", "start"]}}},
 {"type": "function", "function": {"name": "run_python", "description": "Execute Python code in a sandbox and return stdout.",
   "parameters": {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}}},
]
CALLS = [
 ("What's the weather in Lisbon right now?", "get_weather", {"city": "Lisbon", "units": "metric"}, {"temperature_c": 21.5, "condition": "partly cloudy", "humidity": 0.64}, "It's 21.5 °C and partly cloudy in Lisbon, with 64% humidity."),
 ("Find recent news about the James Webb telescope.", "web_search", {"query": "James Webb Space Telescope news", "num_results": 3}, [{"title": "Webb spots carbon dioxide in exoplanet atmosphere", "url": "https://example.com/a"}, {"title": "New deep field image released", "url": "https://example.com/b"}], "Here are two recent stories: Webb detected carbon dioxide in an exoplanet atmosphere, and a new deep field image was released."),
 ("Put a dentist appointment on my calendar next Tuesday at 3pm for 45 minutes.", "create_calendar_event", {"title": "Dentist appointment", "start": "2026-11-03T15:00:00", "duration_minutes": 45}, {"ok": True, "event_id": "evt_83jd92"}, "Done — your dentist appointment is booked for Tuesday at 3:00 PM for 45 minutes."),
 ("What is the sum of the squares from 1 to 100?", "run_python", {"code": "print(sum(i*i for i in range(1, 101)))"}, "338350\n", "The sum of the squares from 1 to 100 is 338,350."),
 ("Search for the best hiking trails near Denver.", "web_search", {"query": "best hiking trails near Denver"}, [{"title": "Top 10 Denver hikes", "url": "https://example.org/hikes", "snippet": "Royal Arch, Mount Falcon, Red Rocks..."}], "Popular trails near Denver include Royal Arch, Mount Falcon and the Red Rocks loop."),
 ("How cold is it in Oslo in Fahrenheit?", "get_weather", {"city": "Oslo", "units": "imperial"}, {"temperature_f": 28, "condition": "snow"}, "It's 28 °F with snow in Oslo."),
 ("Calculate 2 to the power of 64.", "run_python", {"code": "print(2**64)"}, "18446744073709551616\n", "2^64 = 18,446,744,073,709,551,616."),
 ("Schedule a team sync tomorrow at 10am.", "create_calendar_event", {"title": "Team sync", "start": "2026-10-29T10:00:00", "duration_minutes": 30}, {"ok": True, "event_id": "evt_1k2j3"}, "Your team sync is scheduled for tomorrow at 10:00 AM."),
]

def tool_transcripts(render_full):
    out = []
    for i, (q, fn, args, resp, ans) in enumerate(CALLS):
        msgs = [{"role": "system", "content": "You are a helpful assistant running on the user's phone."},
                {"role": "user", "content": q},
                {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": fn, "arguments": args}}]},
                {"role": "tool", "content": json.dumps(resp)},
                {"role": "assistant", "content": ans}]
        out.append(render_full(msgs, TOOLS))
    return {'train': out[:5], 'test': out[5:]}

def build(dl, calib_json, stdlib, sitepk, nodemods, render_full, tok):
    C = {}
    t = pq.read_table(os.path.join(dl, 'wikitext/wikitext-2-raw-v1/train-00000-of-00001.parquet')).column('text').to_pylist()
    txt = ''.join(t); docs = [d for d in re.split(r'\n(?= = [^=])', txt) if d.strip()]
    C['english_wiki'] = {'train': docs, 'test': ['\n'.join(pq.read_table(os.path.join(dl, 'wikitext/wikitext-2-raw-v1/test-00000-of-00001.parquet')).column('text').to_pylist())]}
    chats = [tok.decode(s, skip_special_tokens=False) for s in json.load(open(calib_json))[48:]]
    C['english_chat'] = {'train': chats, 'test': []}  # test chats added by caller (fresh generations)
    C['python'] = code_files([stdlib, sitepk], ['.py'], 12_000_000)
    C['js_ts'] = code_files([nodemods], ['.js', '.mjs', '.ts', '.cjs'], 6_000_000)
    C['markdown_json'] = code_files([nodemods, sitepk], ['.md', '.json', '.rst', '.txt'], 4_000_000)
    C['tool_calls'] = tool_transcripts(render_full)
    return C
