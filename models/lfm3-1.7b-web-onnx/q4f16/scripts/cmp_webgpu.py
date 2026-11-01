import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lm import LM, load_tok, generate
S = sys.argv[1]; tok, _ = load_tok(S + '/dl')
traj = json.load(open(S + '/out/traj.json'))
V = {'orig': 'dl/onnx/model_q4f16', 'rope16k': 'out/rope16k/model_q4f16', 'gptq128': 'out/gptq128/model_q4f16', 'gptq_keepfused': 'out/gptq_keepfused/model_q4f16'}
fp16 = LM(S + '/dl/onnx/model_fp16.cpu.onnx')
ref = np.concatenate([np.stack(generate(fp16, t['ids'], len(t['traj']), forced=t['traj'])[1]) for t in traj]); del fp16
wg = {}
for n, p in V.items():
    wg[n] = np.fromfile(f'{S}/out/wg_{n}.bin', np.float16).reshape(-1, 128000).astype(np.float32)
    lm = LM(f'{S}/{p}.cpu.onnx')
    cpu = np.concatenate([np.stack(generate(lm, t['ids'], len(t['traj']), forced=t['traj'])[1]) for t in traj]); del lm
    meta = json.loads(open(f'{S}/out/wg_{n}.json').read())
    def kl(a, b):
        la = a - np.log(np.exp(a - a.max(-1, keepdims=True)).sum(-1, keepdims=True)) - a.max(-1, keepdims=True)
        lb = b - np.log(np.exp(b - b.max(-1, keepdims=True)).sum(-1, keepdims=True)) - b.max(-1, keepdims=True)
        return float((np.exp(la) * (la - lb)).sum(-1).mean())
    print(f"{n:15s} steps={len(cpu)} WebGPU-vs-CPU(same model): top1={np.mean(wg[n].argmax(-1)==cpu.argmax(-1))*100:.1f}% maxdiff={np.abs(wg[n]-cpu).max():.3f} | "
          f"WebGPU-vs-WebGPU-orig: top1={np.mean(wg[n].argmax(-1)==wg['orig'].argmax(-1))*100:.1f}% maxdiff={np.abs(wg[n]-wg['orig']).max():.3f} | "
          f"WebGPU vs fp16: top1={np.mean(wg[n].argmax(-1)==ref.argmax(-1))*100:.1f}% KL={kl(ref, wg[n]):.4f} | load {meta['loadMs']}ms decode {meta['msPerDecodeStep']:.1f}ms/tok")
    meta['texts'] = [tok.decode(f, skip_special_tokens=True) for f in meta['free']]
    json.dump(meta, open(f'{S}/out/wg_{n}_texts.json', 'w'), indent=1)
