"""Per-language tool scores of tools.html runs on the WebGL engine, from its RESULTS_FILE(s).
usage: webglsum.py <results.jsonl> ...     (<tool_call> is token 125019)"""
import sys, json, collections
TC = 125019
by = collections.defaultdict(dict)
for p in sys.argv[1:]:
    for line in open(p):
        d = json.loads(line)
        if d.get("page") != "tools":
            continue
        rows = d["rows"]
        by[d["params"]["model"]][d["params"]["set"].replace("lfm3", "en")] = {
            "mean_p": sum(r["p_tool_call"] for r in rows) / len(rows), "greedy": sum(r["top"] == TC for r in rows),
            "never": sum(TC not in r["reply"] for r in rows), "n": len(rows)}
for m, L in by.items():
    ml = [l for l in L if l != "en"]
    s = " ".join(f"{l}:{L[l]['greedy']}" for l in ["en"] + ml if l in L)
    if ml:
        print(f"{m}: en P {L['en']['mean_p']:.3f} {L['en']['greedy']}/20 never {L['en']['never']} | other languages P {sum(L[l]['mean_p'] for l in ml)/len(ml):.3f} "
              f"greedy {sum(L[l]['greedy'] for l in ml)}/{20*len(ml)} never {sum(L[l]['never'] for l in ml)} | {s}")
    else:
        print(f"{m}: en P {L['en']['mean_p']:.3f} {L['en']['greedy']}/20 never {L['en']['never']}")
