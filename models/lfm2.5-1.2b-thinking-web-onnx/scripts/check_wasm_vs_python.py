import sys, json, glob, numpy as np, onnxruntime as ort
root = sys.argv[1]
py = json.load(open(f"{root}/out/python_results.json"))
s = ort.InferenceSession(f"{root}/out/onnx/model_q4.onnx", providers=["CPUExecutionProvider"])
for f in sorted(glob.glob(f"{root}/out/wasm_*.json")):
    w = json.load(open(f)); ids = py[w["promptName"]]["prompt_ids"]; toks = w["tokens"]
    feeds = {i.name: (np.zeros((1, 2048, 3), np.float32) if i.name.startswith("past_conv") else np.zeros((1, 8, 0, 64), np.float32)) for i in s.get_inputs() if i.name.startswith("past")}
    seq = ids + toks[:-1]
    feeds.update(input_ids=np.array([seq], np.int64), attention_mask=np.ones((1, len(seq)), np.int64), num_logits_to_keep=np.array(len(toks), np.int64))
    lg = s.run(["logits"], feeds)[0][0]
    am = lg.argmax(-1).tolist(); mx = lg.max(-1)
    print(f.split('/')[-1], "argmax agree %d/%d" % (sum(a == b for a, b in zip(am, toks)), len(toks)),
          "max |maxlogit diff| %.2e" % float(np.max(np.abs(mx - np.array(w["maxLogits"])))),
          "top5 same as python:", w["firstTop5"] == py[w["promptName"]]["top5_after_prompt"])
