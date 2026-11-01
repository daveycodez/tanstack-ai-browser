import json, sys, statistics as st, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
by = collections.defaultdict(list)
for r in rows:
    if r.get("error") or not r.get("cachedBefore") or not r["tag"].startswith("r"):
        continue
    by[r["file"]].append(r)
for f, rs in by.items():
    rd = [r["read"] for r in rs]; wr = [r["write"] for r in rs]; ft = [r["first"] for r in rs]
    print(f"{f:28s} n={len(rs):2d} read med {st.median(rd):5.1f} [{min(rd)}-{max(rd)}]  write med {st.median(wr):5.1f} [{min(wr)}-{max(wr)}]  first med {st.median(ft):5.1f}  temps {sorted(set(r['battTemp'] for r in rs))}")
