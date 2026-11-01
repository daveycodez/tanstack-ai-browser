"""Round-trip check of a llama-server's tokenizer against an HF tokenizer.json.
usage: tokcheck.py <port> <tokenizer.json>"""
import json, sys, urllib.request
from tokenizers import Tokenizer

port, tj = sys.argv[1], sys.argv[2]
hf = Tokenizer.from_file(tj)

def post(path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

TEXTS = {
    "english": "The quick brown fox jumps over the lazy dog. Antidisestablishmentarianism isn't common; neither is 'floccinaucinihilipilification'.",
    "code": "function fib(n) {\n  let [a, b] = [0, 1];\n  for (let i = 0; i < n; i++) [a, b] = [b, a + b];\n  return a;\n}\n\nconst x = await fetch(`https://api.example.com/v1/items?id=${id}`);\n\tif (x?.ok) { console.log(x.status >>> 0, 0xFF, 3.14e-10); }\n",
    "emoji": "Great job! 🎉🔥👍🏽 👨‍👩‍👧‍👦 ❤️ 🇯🇵 — done ✅",
    "non_english": "Привет, как дела? 你好，世界！こんにちは。안녕하세요. مرحبا بالعالم. नमस्ते दुनिया. Ελληνικά. Tiếng Việt có dấu. ภาษาไทย. Größe, façade, naïve, smørrebrød.",
    "whitespace": "  leading spaces\n\n\n\ttabs\t\tand   multiple    spaces   \r\nCRLF line\n    indented\n",
    "chat": "<|startoftext|><|im_start|>system\nYou are a helpful assistant.<|im_end|>\n<|im_start|>user\nHi there!<|im_end|>\n<|im_start|>assistant\n<think>\nThe user greets me.\n</think>\n\nHello! How can I help?<|im_end|>\n",
    "toolcall": "<|im_start|>assistant\n<tool_call>\n<function=get_weather>\n<parameter=city>\nParis\n</parameter>\n<parameter=unit>\ncelsius\n</parameter>\n</function>\n</tool_call><|im_end|>\n<|im_start|>user\n<tool_response>\n{\"temp_c\": 18, \"conditions\": \"light rain\"}\n</tool_response><|im_end|>\n",
    "numbers": "1234567890 12,345.67 2026-10-30T19:45:00Z +1 (555) 010-9999 1e100 ½ ¾ ①②③",
}

ok_all = True
for name, text in TEXTS.items():
    ids = post("/tokenize", {"content": text, "add_special": False, "parse_special": True})["tokens"]
    back = post("/detokenize", {"tokens": ids})["content"]
    hf_ids = hf.encode(text, add_special_tokens=False).ids
    rt = back == text
    same = ids == hf_ids
    ok_all &= rt and same
    print(f"{name:12s} llama={len(ids):4d} hf={len(hf_ids):4d} roundtrip={rt} same_ids_as_hf={same}")
    if not rt:
        print("   back:", repr(back[:200]))
    if not same:
        for i, (a, b) in enumerate(zip(ids, hf_ids)):
            if a != b:
                print("   first diff at", i, a, b, repr(hf.decode([a])), repr(hf.decode([b])))
                break
print("ALL_OK" if ok_all else "SOME_FAIL")
