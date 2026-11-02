"""Text for calibration and evaluation in LFM3's 16 languages.

usage:
  prepdata.py belebele <belebele data dir> <out dir>            one file per language: the unique FLORES passages of Belebele, in order
  prepdata.py wiki <tokenizer.json> <out dir> [tokens per lang]  random Wikipedia article intros per language (calibration), default 6000 tokens
"""
import sys, os, json, time, urllib.request, urllib.parse, urllib.error

LANGS = {  # code: (belebele config, wikipedia subdomain)
    "en": ("eng_Latn", "en"), "ar": ("arb_Arab", "ar"), "zh": ("zho_Hans", "zh"), "fr": ("fra_Latn", "fr"),
    "de": ("deu_Latn", "de"), "it": ("ita_Latn", "it"), "ja": ("jpn_Jpan", "ja"), "ko": ("kor_Hang", "ko"),
    "pt": ("por_Latn", "pt"), "es": ("spa_Latn", "es"), "vi": ("vie_Latn", "vi"), "th": ("tha_Thai", "th"),
    "id": ("ind_Latn", "id"), "hi": ("hin_Deva", "hi"), "ru": ("rus_Cyrl", "ru"), "pl": ("pol_Latn", "pl"),
}

cmd = sys.argv[1]
if cmd == "belebele":
    src, out = sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    for code, (cfg, _) in LANGS.items():
        seen, passages = set(), []
        for line in open(os.path.join(src, cfg + ".jsonl"), encoding="utf-8"):
            p = json.loads(line)["flores_passage"].strip()
            if p not in seen:
                seen.add(p); passages.append(p)
        open(os.path.join(out, f"{code}.txt"), "w", encoding="utf-8").write("\n\n".join(passages) + "\n")
        print(code, len(passages), "passages")
elif cmd == "wiki":
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(sys.argv[2]); out = sys.argv[3]
    want = int(sys.argv[4]) if len(sys.argv) > 4 else 6000
    os.makedirs(out, exist_ok=True)
    for code, (_, wp) in LANGS.items():
        if os.path.exists(os.path.join(out, f"{code}.txt")):
            continue
        texts, n, seen = [], 0, set()
        while n < want:
            q = urllib.parse.urlencode({"action": "query", "format": "json", "generator": "random", "grnnamespace": 0, "grnlimit": 20,
                                        "prop": "extracts", "exintro": 1, "explaintext": 1, "exlimit": "max"})
            req = urllib.request.Request(f"https://{wp}.wikipedia.org/w/api.php?{q}", headers={"User-Agent": "lfm3-head-experiment/0.1 (research)"})
            try:
                pages = json.load(urllib.request.urlopen(req, timeout=60)).get("query", {}).get("pages", {})
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(30); continue
            for p in pages.values():
                e = (p.get("extract") or "").strip()
                if len(e) < 150 or p["pageid"] in seen:
                    continue
                seen.add(p["pageid"]); texts.append(e); n += len(tok.encode(e).ids)
            time.sleep(3)
        open(os.path.join(out, f"{code}.txt"), "w", encoding="utf-8").write("\n\n".join(texts) + "\n")
        print(code, len(texts), "intros", n, "tokens", flush=True)
else:
    sys.exit(__doc__)
