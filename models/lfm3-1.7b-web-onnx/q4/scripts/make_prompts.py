import sys, json
from transformers import AutoTokenizer
repo, out = sys.argv[1], sys.argv[2]
tok = AutoTokenizer.from_pretrained(repo)
license_text = open(f"{repo}/LICENSE").read()
template_text = open(f"{repo}/chat_template.jinja").read()

weather_tool = {"type": "function", "function": {"name": "get_weather", "description": "Get the current weather for a city.",
    "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "City name"},
    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["city"]}}}
more_tools = [weather_tool] + [
 {"type": "function", "function": {"name": "search_web", "description": "Search the web and return the top results with titles, URLs and short snippets. Use it for recent events or facts you are unsure about.",
   "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "max_results": {"type": "integer", "description": "1-10"}}, "required": ["query"]}}},
 {"type": "function", "function": {"name": "create_calendar_event", "description": "Create an event in the user's calendar.",
   "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "start": {"type": "string", "description": "ISO 8601 start time"},
   "end": {"type": "string", "description": "ISO 8601 end time"}, "attendees": {"type": "array", "items": {"type": "string"}}, "location": {"type": "string"}}, "required": ["title", "start"]}}},
 {"type": "function", "function": {"name": "run_python", "description": "Execute a short Python snippet in a sandbox and return stdout.",
   "parameters": {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}}},
]
long_chat = [
 {"role": "system", "content": "You are a careful assistant inside a note-taking app. Keep answers short and use the tools when they help."},
 {"role": "user", "content": "I'm planning a trip to Lisbon next week. What should I pack?"},
 {"role": "assistant", "content": "For Lisbon in late autumn, pack layers: a light waterproof jacket, a sweater, comfortable walking shoes with good grip for the steep cobbled streets, and an umbrella. Days are often mild, around 17 to 20 degrees, with cooler evenings."},
 {"role": "user", "content": "Can you put a reminder in my calendar to book the airport transfer on Monday at 9?"},
 {"role": "assistant", "tool_calls": [{"type": "function", "function": {"name": "create_calendar_event", "arguments": {"title": "Book airport transfer", "start": "2026-11-02T09:00:00"}}}]},
 {"role": "tool", "content": "{\"status\": \"created\", \"id\": \"evt_4821\"}"},
 {"role": "assistant", "content": "Done: \"Book airport transfer\" is in your calendar for Monday at 9:00."},
 {"role": "user", "content": "Thanks. Also, how many days are there between November 2 and December 24 this year? And what's the weather in Lisbon right now?"},
]
prompts = {
 "short_fact": ([{"role": "user", "content": "What is the capital of Australia? Answer in one sentence."}], None, False),
 "short_haiku": ([{"role": "user", "content": "Write a haiku about a lighthouse in fog."}], None, True),
 "tool_weather": ([{"role": "user", "content": "What's the weather like in Osaka right now, in celsius?"}], [weather_tool], False),
 "doc_license_q": ([{"role": "user", "content": "Here is a license text:\n\n" + license_text[:3000] + "\n\nIn two sentences, who may use the model commercially?"}], None, False),
 "tools_long_chat": (long_chat, more_tools, False),
 "doc_template_long": ([{"role": "user", "content": "Explain what this Jinja chat template does, section by section:\n\n```jinja\n" + template_text[:7000] + "\n```"}], None, False),
}
res = {}
for k, (msgs, tools, think) in prompts.items():
    text = tok.apply_chat_template(msgs, tools=tools, tokenize=False, add_generation_prompt=True, enable_thinking=think)
    ids = tok(text, add_special_tokens=False)["input_ids"]
    assert tok.decode(ids) == text
    res[k] = {"ids": ids, "text": text}
    print(k, len(ids))
json.dump(res, open(out, "w"))
print(repr(res["tool_weather"]["text"][-600:]))
