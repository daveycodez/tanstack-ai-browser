import json, sys, urllib.request

port = sys.argv[1]
URL = f"http://127.0.0.1:{port}/v1/chat/completions"

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["city"],
        },
    },
}, {
    "type": "function",
    "function": {
        "name": "add_todo",
        "description": "Add an item to the user's todo list.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "due": {"type": "string", "description": "ISO date"},
            },
            "required": ["title"],
        },
    },
}]

CASES = [
    ("capital", {"messages": [{"role": "user", "content": "What is the capital of Australia, and why isn't it Sydney? Answer in two sentences."}]}, False),
    ("code", {"messages": [{"role": "user", "content": "Write a JavaScript function that returns the n-th Fibonacci number iteratively. Code only."}]}, False),
    ("tool_weather", {"messages": [{"role": "user", "content": "What's the weather like in Paris right now, in celsius?"}], "tools": TOOLS}, False),
    ("tool_todo", {"messages": [{"role": "user", "content": "Remind me to buy milk on 2026-11-02."}], "tools": TOOLS}, False),
    ("tool_followup", {"messages": [
        {"role": "user", "content": "What's the weather in Tokyo?"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": \"Tokyo\"}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "{\"temp_c\": 18, \"conditions\": \"light rain\"}"},
    ], "tools": TOOLS}, False),
    ("think_math", {"messages": [{"role": "user", "content": "A train leaves at 14:35 and arrives at 17:10. How long is the trip in minutes?"}]}, True),
]

for name, body, think in CASES:
    body = dict(body)
    body.update({"temperature": 0, "max_tokens": 700 if think else 300,
                 "chat_template_kwargs": {"enable_thinking": think}})
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
        m = r["choices"][0]["message"]
        out = {"content": m.get("content"), "tool_calls": m.get("tool_calls"),
               "reasoning_len": len(m.get("reasoning_content") or ""),
               "finish": r["choices"][0].get("finish_reason")}
    except Exception as e:
        out = {"error": str(e)}
    print(json.dumps({"case": name, **out}, ensure_ascii=False))
