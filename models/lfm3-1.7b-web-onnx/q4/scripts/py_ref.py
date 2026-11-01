# python -I py_ref.py prompts.json key steps out_prefix name=model.onnx ...
import sys, json, numpy as np, onnxruntime as ort, time
prompts, key, steps, outp = json.load(open(sys.argv[1])), sys.argv[2], int(sys.argv[3]), sys.argv[4]
for spec in sys.argv[5:]:
    name, p = spec.split("=", 1)
    s = ort.InferenceSession(p, providers=["CPUExecutionProvider"])
    names = [o.name for o in s.get_outputs()]
    f = {}
    for i in s.get_inputs():
        if i.name.startswith("past"):
            dt = np.float16 if "float16" in i.type else np.float32
            f[i.name] = np.zeros([1 if d == "batch_size" else (0 if isinstance(d, str) else d) for d in i.shape], dt)
    ids = prompts[key]["ids"]; inp = ids; total = len(ids); toks = []; rows = []
    for step in range(steps + 1):
        f["input_ids"] = np.array([inp], np.int64); f["attention_mask"] = np.ones((1, total), np.int64); f["num_logits_to_keep"] = np.array(1, np.int64)
        o = dict(zip(names, s.run(None, f))); lg = o["logits"][0, -1].astype(np.float32); rows.append(lg)
        if step == steps: break
        nt = int(lg.argmax()); toks.append(nt); inp = [nt]; total += 1
        for k, v in o.items():
            if k.startswith("present_conv."): f["past_conv." + k[13:]] = v
            elif k.startswith("present."): f["past_key_values." + k[8:]] = v
    np.stack(rows).tofile(f"{outp}.{name}.logits.bin")
    json.dump({"tokens": toks, "top5": [np.argsort(-r)[:5].tolist() for r in rows]}, open(f"{outp}.{name}.json", "w"))
    print(name, toks)
