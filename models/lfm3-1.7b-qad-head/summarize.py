"""Collect every measurement into one table (markdown to stdout, and <out>.json).
usage: summarize.py <work dir> <out prefix>
reads: logs/verify.txt, kl/<ref>/<name>/<corpus>.log, tools/<name>.json (all languages) or tools-en/<name>.json, logs/mem.tsv, bench/llama-bench.jsonl, bench/wllama.jsonl"""
import sys, os, re, json, glob, statistics as st

W, outp = sys.argv[1:3]
LANGS = "en ar zh fr de it ja ko pt es vi th id hi ru pl".split()


def kl(ref, name, corpus):
    p = f"{W}/kl/{ref}/{name}/{corpus}.log"
    if not os.path.exists(p):
        return None
    s = open(p, errors="replace").read()
    m = re.search(r"Mean\s+KLD:\s+([\d.]+)", s); t = re.search(r"Same top p:\s+([\d.]+)", s)
    q = re.search(r"Mean PPL\(Q\)\s+:\s+([\d.]+)", s); b = re.search(r"Mean PPL\(base\)\s+:\s+([\d.]+)", s)
    p99 = re.search(r"99\.0%\s+KLD:\s+([\d.]+)", s)
    if not (m and t):
        return None
    return {"kld": float(m.group(1)), "top": float(t.group(1)), "ppl": float(q.group(1)), "ppl_base": float(b.group(1)), "kld99": float(p99.group(1))}


def agg(ref, name, prefix):
    rows = {l: kl(ref, name, f"{prefix}-{l}") for l in LANGS}
    if any(v is None for v in rows.values()):
        return None
    k = {l: v["kld"] for l, v in rows.items()}
    worst = max(k, key=k.get)
    return {"mean": st.mean(k.values()), "worst": k[worst], "worst_lang": worst, "top": st.mean(v["top"] for v in rows.values()), "per_lang": k}


names = set()
heads = {}
for line in open(f"{W}/logs/verify.txt"):
    m = re.match(r"(\S+) verify: (\d+)/(\d+) other tensors byte-identical.*token_embd (\S+) (\d+) bytes", line)
    if m:
        heads[m.group(1)] = {"ok": m.group(2) == m.group(3) and "differing: none" in line, "type": m.group(4), "head_bytes": int(m.group(5))}
        names.add(m.group(1))
names |= {"qad-shipped", "bf16"}
heads["qad-shipped"] = {"ok": True, "type": "Q6_K", "head_bytes": 215040000}
heads["bf16"] = {"ok": None, "type": "BF16", "head_bytes": 524288000}

mem = {}
if os.path.exists(f"{W}/logs/mem.tsv"):
    for line in open(f"{W}/logs/mem.tsv"):
        n, setup, bufs, rss, foot = line.rstrip("\n").split("\t")
        tot = sum(float(x.split("=")[1]) for x in bufs.split())
        mem.setdefault(n, {})[setup] = {"buf": tot, "rss": float(rss.split("=")[1]), "foot": float(foot.split("=")[1]), "bufs": bufs.strip()}


def mem_for(n):  # memory and speed depend only on the head type: use the measured file of the same type
    if n in mem:
        return mem[n]
    t = heads.get(n, {}).get("type")
    for k in mem:
        if heads.get(k, {}).get("type") == t and k != "qad-shipped" and k != "bf16":
            return mem[k]
    return None


bench = {}
if os.path.exists(f"{W}/bench/llama-bench.jsonl"):
    for line in open(f"{W}/bench/llama-bench.jsonl"):
        d = json.loads(line)
        key = "pp" if d["n_prompt"] > 0 else "tg"
        bench.setdefault(d["name"], {}).setdefault(f"{key}_t{d['n_threads']}", []).append(d["avg_ts"])
wl = {}
if os.path.exists(f"{W}/bench/wllama.jsonl"):
    for line in open(f"{W}/bench/wllama.jsonl"):
        d = json.loads(line)
        if d.get("error") or not d.get("cachedBefore"):
            continue
        n = d["file"].rsplit(".gguf", 1)[0]
        wl.setdefault(n, {"write": [], "read": [], "peak": []})
        wl[n]["write"].append(d["write"]); wl[n]["read"].append(d["read"]); wl[n]["peak"].append(d.get("peakTreeMB") or 0)


def by_type(table, n):
    if n in table:
        return table[n]
    t = heads.get(n, {}).get("type")
    for k in table:
        if heads.get(k, {}).get("type") == t and k not in ("qad-shipped", "bf16"):
            return table[k]
    return None


def med(xs):
    return f"{st.median(xs):.1f} [{min(xs):.1f}–{max(xs):.1f}]" if xs else ""


rows = []
for n in sorted(names, key=lambda x: (x != "bf16", x != "qad-shipped", x)):
    r = {"name": n, **heads.get(n, {})}
    r["file_bytes"] = os.path.getsize(f"{W}/var/{n}.gguf") if os.path.exists(f"{W}/var/{n}.gguf") else None
    tl = f"{W}/tools/{n}.json"
    if not os.path.exists(tl):
        tl = f"{W}/tools-en/{n}.json"  # English only
    if os.path.exists(tl):
        T = json.load(open(tl))
        if "en" in T:
            r["tool_en"] = {k: T["en"][k] for k in ("mean_p", "greedy", "never")}
        ml = [l for l in T if l != "en"]
        if ml:
            g = {l: T[l]["greedy"] for l in ml}
            worst = min(ml, key=lambda l: (T[l]["greedy"], T[l]["mean_p"]))
            r["tool_ml"] = {"mean_p": st.mean(T[l]["mean_p"] for l in ml), "greedy": sum(g.values()), "n": 20 * len(ml),
                            "never": sum(T[l]["never"] for l in ml), "worst": worst, "worst_greedy": g[worst], "per_lang": g}
    for ref in ("bf16", "qad"):
        r[f"{ref}_wiki"] = kl(ref, n, "wiki"); r[f"{ref}_chat"] = kl(ref, n, "chat-en")
        r[f"{ref}_bele"] = agg(ref, n, "bele"); r[f"{ref}_mlchat"] = agg(ref, n, "mlchat")
    r["mem"] = mem_for(n)
    r["bench"] = by_type(bench, n)
    r["wllama"] = by_type(wl, n)
    rows.append(r)
json.dump(rows, open(outp + ".json", "w"), indent=1)


def f(x, k, fmt="{:.4f}"):
    return fmt.format(x[k]) if x and x.get(k) is not None else ""


print("| variant | head | file MB | head MB | buf MiB (flat) | RSS MiB (flat) | tg t4 | pp t4 | wllama write | wllama read | tool en P / greedy / never | tool ml P / greedy / never / worst |"
      " KL→BF16 bele mean / worst | KL→BF16 mlchat mean / worst | KL→BF16 wiki / top% / PPL | KL→BF16 chat / top% / PPL | KL→QAD wiki / bele / mlchat |")
print("|" + "---|" * 17)
for r in rows:
    m = (r.get("mem") or {}).get("flat")
    b = r.get("bench") or {}
    w = r.get("wllama") or {}
    te, tm = r.get("tool_en"), r.get("tool_ml")
    def klc(x, top=False, ppl=False):
        if not x: return ""
        s = f"{x['kld']:.4f}"
        if top: s += f" / {x['top']:.1f}"
        if ppl: s += f" / {x['ppl']:.3f}"
        return s
    def ag(x):
        return f"{x['mean']:.4f} / {x['worst']:.4f} {x['worst_lang']}" if x else ""
    print(f"| {r['name']} | {r.get('type','')} | {r['file_bytes']/1e6:.1f} | {r.get('head_bytes',0)/1e6:.1f} | " if r.get("file_bytes") else f"| {r['name']} | {r.get('type','')} | | {r.get('head_bytes',0)/1e6:.1f} | ", end="")
    print(f"{m['buf']:.0f} | {m['rss']:.0f} | " if m else "| | ", end="")
    print(f"{med(b.get('tg_t4', []))} | {med(b.get('pp_t4', []))} | {med(w.get('write', []))} | {med(w.get('read', []))} | ", end="")
    print(f"{te['mean_p']:.3f} / {te['greedy']}/20 / {te['never']} | " if te else "| ", end="")
    print(f"{tm['mean_p']:.3f} / {tm['greedy']}/{tm['n']} / {tm['never']} / {tm['worst']} {tm['worst_greedy']}/20 | " if tm else "| ", end="")
    print(f"{ag(r['bf16_bele'])} | {ag(r['bf16_mlchat'])} | {klc(r['bf16_wiki'], True, True)} | {klc(r['bf16_chat'], True, True)} | "
          f"{klc(r['qad_wiki'])} / {ag(r['qad_bele']).split(' / ')[0] if r['qad_bele'] else ''} / {ag(r['qad_mlchat']).split(' / ')[0] if r['qad_mlchat'] else ''} |")
