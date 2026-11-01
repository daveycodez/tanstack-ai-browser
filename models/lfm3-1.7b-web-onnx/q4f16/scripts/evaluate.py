import sys, os, json, numpy as np, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lm as LMmod
from lm import LM, load_tok, generate
tokdir, out_json = sys.argv[1], sys.argv[2]
models = [x.split('=', 1) for x in sys.argv[3:]]   # label=path ; first = fp16 ref, second = original q4f16
tok, render = load_tok(tokdir)
STEPS = 64
PROMPTS = [
    'What is the capital of France? Answer in one sentence.',
    'Write a Python function that returns the n-th Fibonacci number iteratively.',
    'Explain in three short bullet points why the sky looks blue.',
    'Give me a two-day itinerary for a first visit to Kyoto.',
    'Summarize the plot of a heist movie you invent, in about 80 words.',
    'If a train leaves at 3:40 pm and the trip takes 2 hours 35 minutes, when does it arrive? Show your steps.',
]
TEXTS = [
    "The old lighthouse keeper climbed the spiral stairs every evening, counting each step out of habit. "
    "From the gallery he could see the fishing boats returning, their lamps bobbing like fireflies over the dark water. "
    "He had kept the light burning for thirty years, through storms that shook the glass and calm nights when the sea was a mirror.",
    "To install the package, first create a virtual environment and activate it. Then run the installer with the "
    "verbose flag so you can see which dependencies are resolved. If the build fails on an older compiler, upgrade "
    "the toolchain or pin the previous minor release in your requirements file.",
    "def merge_sorted(a, b):\n    i = j = 0\n    out = []\n    while i < len(a) and j < len(b):\n        if a[i] <= b[j]:\n"
    "            out.append(a[i]); i += 1\n        else:\n            out.append(b[j]); j += 1\n    out.extend(a[i:])\n"
    "    out.extend(b[j:])\n    return out\n",
    "Photosynthesis converts light energy into chemical energy stored in sugars. In the light-dependent reactions, "
    "chlorophyll absorbs photons and water is split, releasing oxygen. The Calvin cycle then uses ATP and NADPH to fix "
    "carbon dioxide into three-carbon molecules that the plant assembles into glucose.",
    "Hi Maria, thanks for sending the draft over. I read it on the train this morning and I think the structure works well. "
    "The second section could be shorter, and I would move the budget table up front so people see the numbers first. "
    "Can we talk on Thursday afternoon? I am free after two, otherwise Friday morning works too.",
    "A rectangle has a perimeter of 30 centimeters and its length is twice its width. Let the width be w. Then the length "
    "is 2w and the perimeter is 2(w + 2w) = 6w. Setting 6w = 30 gives w = 5, so the rectangle is 5 centimeters wide "
    "and 10 centimeters long, and its area is 50 square centimeters.",
    "Packing list for a weekend hike: a waterproof jacket, two pairs of wool socks, a headlamp with spare batteries, "
    "a first aid kit, sunscreen, a map of the trail, enough water for the first day, a small stove, and food that does "
    "not need refrigeration, such as oats, nuts, dried fruit and pasta.",
    "The city council voted on Tuesday to extend the bike lane network along the river. Supporters said the change "
    "would make commuting safer, while some shop owners worried about losing parking spaces. Construction is expected "
    "to start in the spring and finish before the end of next year.",
    "User: My laptop fan is loud all the time, even when nothing is open. What should I check?\n"
    "Assistant: Start by opening the activity monitor to see whether a background process is using the processor. "
    "Then make sure the vents are not blocked and clean out any dust. If the fan is still loud, check for system updates.",
]
prompt_ids = [tok.encode(render([{'role': 'user', 'content': p}]), add_special_tokens=False).ids for p in PROMPTS]
text_ids = [[LMmod.BOS] + tok.encode(t, add_special_tokens=False).ids for t in TEXTS]

def nll(lm, ids):
    cache = lm.empty_cache()
    feed = dict(cache); feed['input_ids'] = np.array([ids], np.int64)
    feed['attention_mask'] = np.ones((1, len(ids)), np.int64)
    feed['num_logits_to_keep'] = np.array(len(ids), np.int64)
    lg = lm.s.run(['logits'], feed)[0][0].astype(np.float64)
    lg = lg[:-1]; tgt = np.array(ids[1:])
    lse = np.log(np.exp(lg - lg.max(-1, keepdims=True)).sum(-1)) + lg.max(-1)
    return float((lse - lg[np.arange(len(tgt)), tgt]).sum()), len(tgt)

res = {}; ref = {}
for label, path in models:
    t0 = time.time(); lm = LM(path); r = {'path': path}
    free = [generate(lm, ids, STEPS)[0] for ids in prompt_ids]
    r['free_text'] = [tok.decode(t, skip_special_tokens=True) for t in free]
    if not ref:
        ref['fp16_traj'] = free
    if len(ref) == 1 and label != models[0][0]:
        ref['orig_traj'] = free
    # teacher-forced on fp16 trajectory and on original-q4 trajectory
    for key in ['fp16_traj', 'orig_traj']:
        if key not in ref: continue
        logits_all = []
        for ids, traj in zip(prompt_ids, ref[key]):
            _, lg = generate(lm, ids, len(traj), forced=traj)
            logits_all.append(np.stack(lg))
        r['_logits_' + key] = logits_all
    tot, n = 0.0, 0
    for ids in text_ids:
        a_, b_ = nll(lm, ids); tot += a_; n += b_
    r['ppl'] = float(np.exp(tot / n)); r['nll_tokens'] = n
    r['free_match_fp16'] = [int(np.mean([x == y for x, y in zip(f, g)]) * 100) if True else 0 for f, g in zip(free, ref['fp16_traj'])]
    res[label] = r
    del lm
    print(label, 'done', f'{time.time()-t0:.0f}s ppl={r["ppl"]:.3f}', flush=True)

labels = [l for l, _ in models]
def first_div(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y: return i
    return min(len(a), len(b))
summary = {}
for l in labels:
    r = res[l]; s = {'ppl': round(r['ppl'], 4)}
    for key, base in [('fp16_traj', labels[0]), ('orig_traj', labels[1])]:
        if '_logits_' + key not in r or '_logits_' + key not in res[base]: continue
        A = r['_logits_' + key]; B = res[base]['_logits_' + key]
        agree = np.mean(np.concatenate([(a.argmax(-1) == b.argmax(-1)) for a, b in zip(A, B)]))
        maxdiff = max(float(np.abs(a - b).max()) for a, b in zip(A, B))
        meandiff = float(np.mean(np.concatenate([np.abs(a - b).mean(-1) for a, b in zip(A, B)])))
        def kl(a, b):
            pa = np.exp(a - a.max(-1, keepdims=True)); pa /= pa.sum(-1, keepdims=True)
            pb = np.exp(b - b.max(-1, keepdims=True)); pb /= pb.sum(-1, keepdims=True)
            return (pb * (np.log(pb + 1e-12) - np.log(pa + 1e-12))).sum(-1)
        klv = float(np.mean(np.concatenate([kl(a.astype(np.float64), b.astype(np.float64)) for a, b in zip(A, B)])))
        s[f'top1_vs_{base}'] = round(float(agree) * 100, 2)
        s[f'maxlogitdiff_vs_{base}'] = round(maxdiff, 3)
        s[f'meanlogitdiff_vs_{base}'] = round(meandiff, 4)
        s[f'KL({base}||this)'] = round(klv, 5)
        s['steps'] = int(sum(len(a) for a in A))
    s['free_run_first_divergence_vs_fp16'] = [first_div(f, g) for f, g in zip([tok.encode(t, add_special_tokens=False).ids for t in r['free_text']], [tok.encode(t, add_special_tokens=False).ids for t in res[labels[0]]['free_text']])]
    s['free_run_first_divergence_vs_orig'] = [first_div(f, g) for f, g in zip([tok.encode(t, add_special_tokens=False).ids for t in r['free_text']], [tok.encode(t, add_special_tokens=False).ids for t in res[labels[1]]['free_text']])]
    summary[l] = s
    print(l, json.dumps(s))
json.dump({'summary': summary, 'prompts': PROMPTS, 'texts': {l: res[l]['free_text'] for l in labels}}, open(out_json, 'w'), indent=1)
