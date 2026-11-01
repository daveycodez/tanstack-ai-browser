import json, sys, urllib.request

port, out = sys.argv[1], sys.argv[2]
URL = f"http://127.0.0.1:{port}/v1/chat/completions"
P = """Explain how a refrigerator keeps food cold.
Write a short, friendly email asking a coworker to review my pull request.
What are three good habits for staying focused while working from home?
Summarize the plot of Romeo and Juliet in one paragraph.
How do I reverse a linked list in Python? Show code and explain it.
Give me a vegetarian dinner recipe that takes under 30 minutes.
What is the difference between TCP and UDP?
Write a haiku about autumn rain.
I have a job interview tomorrow for a junior designer role. How should I prepare?
Explain compound interest to a 12-year-old.
What causes the seasons on Earth?
Translate 'Where is the train station?' into French, Spanish and German.
Write a SQL query that finds the top 5 customers by total order value.
What are the pros and cons of electric cars?
How does the immune system fight a virus?
Suggest names for a small coffee shop near a university.
Explain what a React useEffect hook does, with an example.
Plan a 3-day trip to Rome for someone who loves history and food.
What is the Pythagorean theorem and where is it used in real life?
Write a short story opening about a lighthouse keeper who finds a message in a bottle.
How can I improve my sleep quality?
Explain the difference between machine learning and traditional programming.
My sourdough bread is too dense. What might be going wrong?
Describe how a bill becomes a law in the United States.
Write a bash one-liner that counts lines in all .ts files in a directory tree.
What should I consider when adopting a dog?
Explain photosynthesis step by step.
Give feedback on this sentence: 'Me and him goes to the store yesterday.'
What are some tips for public speaking?
How does HTTPS keep my data safe?
Compare Python lists and tuples.
Write a polite message declining a meeting invitation.
What happened during the French Revolution, briefly?
How do vaccines work?
Create a weekly workout plan for a beginner.
Explain what an API is using a restaurant analogy.
What is inflation and why does it happen?
Write a limerick about a cat who loves cheese.
How do I center a div with CSS? Show two ways.
What are black holes and how do they form?""".strip().split("\n")

with open(out, "w") as fo:
    for i, p in enumerate(P):
        body = {"messages": [{"role": "user", "content": p}], "temperature": 0.7, "seed": i,
                "max_tokens": 450, "chat_template_kwargs": {"enable_thinking": False}}
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        r = json.load(urllib.request.urlopen(req, timeout=300))
        c = r["choices"][0]["message"].get("content") or ""
        fo.write(f"User: {p}\n\nAssistant: {c.strip()}\n\n")
        print(i, len(c), file=sys.stderr)
