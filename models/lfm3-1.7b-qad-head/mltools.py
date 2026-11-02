"""Render the 20 tool prompts (prompts/tool_prompts_ml.json, model-written translations) with LFM3's chat template and the
same four tools as packages/webgl/bench/tool-ref/make_lfm3_ref.py, thinking off, as token ids: one set per language,
in the format of tools.html's tool_prompts.json. Checks that the English set is token-identical to the reference set.
usage: mltools.py <LFM3 tokenizer dir (tokenizer.json, chat_template.jinja)> <reference tool_prompts.json> <out dir>"""
import sys, os, json, re, jinja2
from tokenizers import Tokenizer

H = os.path.dirname(os.path.abspath(__file__))
tokdir, refp, out = sys.argv[1:4]
TOOLS = [  # models/lfm3-1.7b-web-onnx/q4f16/scripts/corpus.py TOOLS
    {"type": "function", "function": {"name": "web_search", "description": "Search the web and return the top results.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "What to search for"}, "num_results": {"type": "integer"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "get_weather", "description": "Get the current weather for a city.",
     "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "units": {"type": "string", "enum": ["metric", "imperial"]}}, "required": ["city"]}}},
    {"type": "function", "function": {"name": "create_calendar_event", "description": "Create an event in the user's calendar.",
     "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "start": {"type": "string", "description": "ISO 8601 date-time"}, "duration_minutes": {"type": "integer"}}, "required": ["title", "start"]}}},
    {"type": "function", "function": {"name": "run_python", "description": "Execute Python code in a sandbox and return stdout.",
     "parameters": {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}}},
]
tok = Tokenizer.from_file(os.path.join(tokdir, "tokenizer.json"))
tmpl = re.sub(r'\{%-?\s*(end)?generation\s*-?%\}', '', open(os.path.join(tokdir, "chat_template.jinja")).read())
env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True); env.filters['tojson'] = lambda v, **k: json.dumps(v, ensure_ascii=False)
T = env.from_string(tmpl)
ref = json.load(open(refp))
Q = json.load(open(os.path.join(H, "prompts", "tool_prompts_ml.json")))
os.makedirs(out, exist_ok=True)
for lang, qs in Q.items():
    assert len(qs) == 20, lang
    prompts = []
    for q in qs:
        p = T.render(messages=[{'role': 'user', 'content': q}], tools=TOOLS, bos_token='<|startoftext|>', add_generation_prompt=True, enable_thinking=False)
        prompts.append({'question': q, 'ids': tok.encode(p, add_special_tokens=False).ids})
    if lang == "en":
        same = sum(a['ids'] == b['ids'] for a, b in zip(prompts, ref['prompts']))
        print(f"en: {same}/20 prompts token-identical to the reference set")
        assert same == 20
    os.makedirs(os.path.join(out, lang), exist_ok=True)
    json.dump({'tool_call_id': ref['tool_call_id'], 'eos_id': ref['eos_id'], 'vocab': ref['vocab'], 'refs': [], 'prompts': prompts},
              open(os.path.join(out, lang, "tool_prompts.json"), "w"), ensure_ascii=False, indent=1)
    print(lang, "user-message tokens:", [len(tok.encode(q, add_special_tokens=False).ids) for q in qs][:6], "...")
