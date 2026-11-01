"""WebGPU (onnxruntime-node) vs CPU for one trimmed-vocab model, teacher-forced on its own CPU greedy trajectories."""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lm as L
S, label, model_cpu, tokdir, traj_p, wg_prefix = sys.argv[1:7]
tok, _ = L.load_tok(tokdir); traj = json.load(open(traj_p))
lm = L.LM(model_cpu)
cpu = np.concatenate([np.stack(L.generate(lm, t['ids'], len(t['traj']), forced=t['traj'])[1]) for t in traj])
V = cpu.shape[-1]
wg = np.fromfile(wg_prefix + '.bin', np.float16).reshape(-1, V).astype(np.float32)
meta = json.load(open(wg_prefix + '.json'))
print(json.dumps({'label': label, 'steps': len(cpu), 'webgpu_vs_cpu_top1_pct': round(float(np.mean(wg.argmax(-1) == cpu.argmax(-1))) * 100, 2),
                  'max_logit_diff': round(float(np.abs(wg - cpu).max()), 3), 'webgpu_ms_per_decode_step': round(meta['msPerDecodeStep'], 1), 'load_ms': meta['loadMs']}))
texts = [tok.decode(f, skip_special_tokens=True) for f in meta['free']]
json.dump({'prompts': [t['prompt'] for t in traj], 'webgpu_free_run': texts}, open(wg_prefix + '_texts.json', 'w'), indent=1)
