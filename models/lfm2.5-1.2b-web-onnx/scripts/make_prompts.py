import json, sys
from jinja2.sandbox import ImmutableSandboxedEnvironment
from tokenizers import Tokenizer
repo, out = sys.argv[1], sys.argv[2]
env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=['jinja2.ext.loopcontrols'])
env.filters['tojson'] = lambda x, indent=None, separators=None, sort_keys=False, ensure_ascii=False: json.dumps(x, ensure_ascii=ensure_ascii, indent=indent, separators=separators, sort_keys=sort_keys)
tmpl = env.from_string(open(f'{repo}/chat_template.jinja').read())
tok = Tokenizer.from_file(f'{repo}/tokenizer.json')

MEMO = """The Harbor District water board met on Tuesday to review the second phase of the stormwater plan. The first phase, finished last spring, replaced roughly four kilometres of clay pipe under Market Street and Ferry Lane with larger concrete culverts. Since then, street flooding during heavy rain has dropped noticeably: the board counted three flooded intersections during the October storms, compared with eleven the year before.

The second phase is harder. It covers the low ground east of the old cannery, where the pipes run below the high-tide line. When a storm arrives at high tide, seawater backs up into the drains and rainwater has nowhere to go. Engineers proposed three options. The first is a set of one-way tide valves at the four outfalls, which would stop seawater from entering but would also trap rainwater behind them until the tide falls. The second is a pumping station near the cannery that would push stormwater out over the tide; it is the most reliable option but also the most expensive, and it needs a permanent power supply and staff. The third is a mix: tide valves now, plus a storage basin under the new park on Rope Walk that would hold rainwater for a few hours until the valves can open again.

Board members disagreed about cost. The pumping station was estimated at 14 million, the valves alone at 2.5 million, and the valves with the storage basin at 7 million. Several residents spoke during public comment. A shop owner on Cannery Row said her basement had flooded twice in three years and asked for the most reliable option regardless of price. A retired engineer argued that pumps fail exactly when they are needed most, during power cuts in big storms, and that the storage basin was the more robust choice. A parent from the school on Rope Walk asked whether construction of the basin would close the playground, and staff said it would be closed for about eight months.

The board also heard a short report on maintenance. Crews cleared 212 storm drains of leaves and litter in the autumn, and the district bought a second vacuum truck. Staff warned that maintenance spending would need to rise by about ten percent a year once the new culverts are fully in service, because the larger pipes collect more sediment.

No vote was taken. The chair asked staff to return next month with a more detailed comparison of the three options, including running costs over twenty years, the risk of failure during a power cut, and a construction schedule that keeps at least half of the park open."""

TOOLS = [
 {"type": "function", "function": {"name": "get_weather", "description": "Get the current weather and a short forecast for a city. Use this whenever the user asks about weather, temperature, rain, wind or what to wear outside.", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "City name, optionally with country, e.g. 'Lisbon, Portugal'."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "Temperature unit. Defaults to celsius."}, "days": {"type": "integer", "description": "Number of forecast days, from 1 to 7."}}, "required": ["city"]}}},
 {"type": "function", "function": {"name": "search_notes", "description": "Search the user's saved notes by keyword and return the titles, dates and first lines of matching notes, newest first.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Words to search for."}, "limit": {"type": "integer", "description": "Maximum number of results, default 5."}, "tag": {"type": "string", "description": "Only return notes with this tag."}}, "required": ["query"]}}},
 {"type": "function", "function": {"name": "create_calendar_event", "description": "Create an event in the user's calendar. Ask for missing details instead of guessing the date or time.", "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "start": {"type": "string", "description": "Start time in ISO 8601 format, e.g. 2026-11-03T14:00."}, "end": {"type": "string", "description": "End time in ISO 8601 format."}, "location": {"type": "string"}, "attendees": {"type": "array", "items": {"type": "string"}, "description": "Email addresses of people to invite."}, "reminder_minutes": {"type": "integer", "description": "Minutes before the start to send a reminder."}}, "required": ["title", "start"]}}},
 {"type": "function", "function": {"name": "convert_currency", "description": "Convert an amount of money from one currency to another using today's exchange rate.", "parameters": {"type": "object", "properties": {"amount": {"type": "number"}, "from_currency": {"type": "string", "description": "Three-letter ISO code, e.g. EUR."}, "to_currency": {"type": "string", "description": "Three-letter ISO code, e.g. JPY."}}, "required": ["amount", "from_currency", "to_currency"]}}},
 {"type": "function", "function": {"name": "set_timer", "description": "Start a countdown timer on the user's device with an optional label.", "parameters": {"type": "object", "properties": {"seconds": {"type": "integer", "description": "Length of the timer in seconds."}, "label": {"type": "string"}}, "required": ["seconds"]}}},
 {"type": "function", "function": {"name": "translate_text", "description": "Translate text between languages. Supports English, Japanese, Korean, French, Spanish, German, Italian, Portuguese, Arabic and Chinese.", "parameters": {"type": "object", "properties": {"text": {"type": "string"}, "target_language": {"type": "string", "description": "Language to translate into."}, "source_language": {"type": "string", "description": "Language of the text; detected automatically if omitted."}, "formal": {"type": "boolean", "description": "Use a formal register where the language has one."}}, "required": ["text", "target_language"]}}},
]

prompts = {
 "short": dict(messages=[{"role": "user", "content": "What is the capital of France? Answer in one sentence."}]),
 "short_system": dict(messages=[{"role": "system", "content": "You are a helpful assistant who answers briefly."}, {"role": "user", "content": "Give me three tips for keeping basil alive on a windowsill."}]),
 "memo_summary": dict(messages=[{"role": "user", "content": "Summarize the following meeting notes in five bullet points, then say which option you would recommend and why.\n\n" + MEMO}]),
 "tools": dict(messages=[{"role": "system", "content": "You are a helpful assistant running in a web browser. Call a tool when it helps; otherwise answer directly. Be concise."}, {"role": "user", "content": "I'm flying to Lisbon on Thursday for a three-day conference. What will the weather be like while I'm there, and please put the opening session in my calendar for Thursday at 9:30 at the Lisbon Congress Centre with a 30 minute reminder."}], tools=TOOLS),
 "multiturn_long": dict(messages=[
    {"role": "system", "content": "You are a careful assistant helping a city council member prepare for a meeting."},
    {"role": "user", "content": "Here are the notes from the last water board meeting:\n\n" + MEMO},
    {"role": "assistant", "content": "<think>The user shared notes; wait for the question.</think>Thanks, I've read the notes. The board is weighing tide valves (2.5 million), valves plus a storage basin under the Rope Walk park (7 million) and a pumping station (14 million), and asked staff for a twenty-year cost comparison. What would you like to do with them?"},
    {"role": "user", "content": "Draft three sharp questions I can ask staff next month, focused on power cuts, running costs and the playground closure. Then list any numbers in the notes that seem to need checking."}]),
}
res = {}
for k, p in prompts.items():
    text = tmpl.render(messages=p['messages'], tools=p.get('tools'), add_generation_prompt=True, bos_token='<|startoftext|>')
    ids = tok.encode(text, add_special_tokens=False).ids
    res[k] = dict(text=text, ids=ids)
    print(k, len(ids), repr(text[:60]), ids[:3])
json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
