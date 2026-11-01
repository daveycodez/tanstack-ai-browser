import numpy as np, onnxruntime as ort, json, jinja2
from tokenizers import Tokenizer

class LM:
    def __init__(self, path, threads=8):
        so = ort.SessionOptions(); so.intra_op_num_threads = threads
        so.log_severity_level = 3
        self.s = ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
        self.inputs = {i.name: i for i in self.s.get_inputs()}
    def empty_cache(self):
        c = {}
        for n, i in self.inputs.items():
            if n.startswith('past_conv'): c[n] = np.zeros((1, 6, 2048), np.float16)
            elif n.startswith('past_key_values'): c[n] = np.zeros((1, 4, 0, 128), np.float16)
        return c
    def step(self, ids, cache, total_len):
        feed = dict(cache)
        feed['input_ids'] = np.array([ids], np.int64)
        feed['attention_mask'] = np.ones((1, total_len), np.int64)
        if 'num_logits_to_keep' in self.inputs: feed['num_logits_to_keep'] = np.array(1, np.int64)
        outs = self.s.run(None, feed)
        names = [o.name for o in self.s.get_outputs()]
        d = dict(zip(names, outs))
        new = {}
        for n in cache:
            new[n] = d[n.replace('past_key_values', 'present').replace('past_conv', 'present_conv')]
        return d['logits'][0, -1].astype(np.float32), new

EOS, BOS = 124900, 124894
def load_tok(d):
    global EOS, BOS
    tok = Tokenizer.from_file(d + '/tokenizer.json')
    EOS, BOS = tok.token_to_id('<|im_end|>'), tok.token_to_id('<|startoftext|>')
    import re
    tmpl = re.sub(r'\{%-?\s*(end)?generation\s*-?%\}', '', open(d + '/chat_template.jinja').read())
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True)
    env.filters['tojson'] = lambda v, **k: json.dumps(v)
    t = env.from_string(tmpl)
    def render(msgs):
        return t.render(messages=msgs, bos_token='<|startoftext|>', add_generation_prompt=True, enable_thinking=False)
    return tok, render

def generate(lm, prompt_ids, steps, forced=None):
    """Greedy. If forced is given, feed those tokens instead (teacher forcing)
    and return per-step logits for comparison."""
    cache = lm.empty_cache()
    logits, cache = lm.step(prompt_ids, cache, len(prompt_ids))
    toks, all_logits = [], [logits]
    total = len(prompt_ids)
    for i in range(steps):
        t = int(np.argmax(logits)) if forced is None else forced[i]
        toks.append(t)
        if t == EOS and forced is None: break
        if i == steps - 1: break
        total += 1
        logits, cache = lm.step([t], cache, total)
        all_logits.append(logits)
    return toks, all_logits
