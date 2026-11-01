import onnxruntime as ort, numpy as np, sys, time
p = sys.argv[1]
so = ort.SessionOptions()
t=time.time()
s = ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])
print("load", time.time()-t)
feeds = {}
ids = np.array([[49013, 100, 200, 300, 400]], dtype=np.int64)
for i in s.get_inputs():
    if i.name=="input_ids": feeds[i.name]=ids
    elif i.name=="attention_mask": feeds[i.name]=np.ones_like(ids)
    elif i.name=="num_logits_to_keep": feeds[i.name]=np.array(1,dtype=np.int64)
    else:
        dt = np.float16 if "16" in i.type else np.float32
        shp = [1 if d=="batch_size" else 0 if isinstance(d,str) else d for d in i.shape]
        feeds[i.name]=np.zeros(shp, dt)
t=time.time()
o = s.run(None, feeds)
print("run", time.time()-t, o[0].shape, o[0].dtype, np.argsort(-o[0][0,-1].astype(np.float32))[:5])
