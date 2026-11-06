# LFM3-1.7B QAD Q4_0: a smaller tied head ("Path A")

An experiment, not a published build: take Liquid AI's QAD Q4_0 GGUF ([LiquidAI/LFM3-1.7B-GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) `LFM3-1.7B-QAD-Q4_0.gguf`) and replace only its tied token embedding / LM head (`token_embd.weight`, 128,000 × 2048, Q6_K, 215 MB). The vocabulary and every other tensor stay as Liquid shipped them; `ggufhead.py verify` checks that by hashing each tensor's bytes and each metadata value. Results: [RESULTS.md](RESULTS.md).

Needs llama.cpp at commit `19cce69` (the commit wllama builds), built natively (`llama-quantize`, `llama-imatrix`, `llama-perplexity`, `llama-server`, `llama-completion`, `llama-bench`), its `gguf-py`, and a Python venv with `numpy`, `tokenizers`, `jinja2` and `pyarrow` (for `mkcal.py`, which imports `../lfm3-1.7b-web-onnx/q4f16/scripts/corpus.py`). Run Python with `-I`. The scripts take these environment variables:

| | |
|---|---|
| `BIN` | llama.cpp's `build/bin` |
| `GGUF_PY` | llama.cpp's `gguf-py` |
| `PY` | the venv's python |
| `W` | a work folder (GGUFs, logs, corpora; about 150 GB with all reference logits) |
| `QAD`, `BF16` | Liquid's `LFM3-1.7B-QAD-Q4_0.gguf` and `LFM3-1.7B-BF16.gguf` |
| `G` | a folder with `wt/wikitext-2-raw/wiki.test.raw` and `q/chat-corpus.txt` (English chat replies written by the BF16 model, from `../lfm3-1.7b-web-gguf/scripts/gencorpus.py`) and `q/cal-mix.txt` (that build's calibration text) |
| `TOKDIR` | LFM3's `tokenizer.json` and `chat_template.jinja` (e.g. onnx-community/LFM3-1.7B-ONNX) |
| `REF` | tools.html's LFM3 set (`tool_prompts.json`), made by `packages/webgllm/bench/tool-ref/make_lfm3_ref.py` |

## Scripts

- `ggufhead.py`: `src` writes a BF16 GGUF whose `token_embd` is the QAD file's Q6_K dequantized to F32 (the "qad" source); `splice` copies the QAD file and swaps in another GGUF's `token_embd` (type and bytes); `verify` hashes every tensor and metadata value against the QAD file; `cmp` compares embeddings (relative error, cosine, identical rows).
- `build_variants.sh <cal> [types]`: for both sources (`bf16`, `qad`), quantizes the embedding with `llama-quantize --pure --token-embedding-type <type> [--imatrix $IMAT]` (the rest of that file is thrown away), splices it into the QAD file as `$W/var/h-<type>-<source>-<cal>.gguf` and verifies it.
- `prepdata.py`: `belebele` writes the 488 unique FLORES passages of [Belebele](https://huggingface.co/datasets/facebook/belebele) per language (evaluation); `wiki` fetches random Wikipedia article intros per language (calibration).
- `genchat.py`: BF16 chat replies, `eval` to the native prompts in `prompts/chat_prompts_ml.json` (one file per language), `cal` to English prompts with "Answer in <language>." (calibration).
- `mkcal.py`: the calibration text (English cal-mix, Wikipedia intros in 16 languages, multilingual chat replies, the 8 tool-call transcripts of `corpus.py`).
- `imatx.py`: `show` prints the head's importance vector stats and compares two matrices; `flat` makes a control matrix with the head's importance all ones.
- `mltools.py`: renders `prompts/tool_prompts_ml.json` (the 20 tool prompts of tools.html, with model-written translations into 15 languages) with LFM3's template and the same four tools, thinking off, one tools.html-style set per language; the English set is checked token-identical to tools.html's.
- `toolscore.py`, `runtools.sh`: the tool score on llama.cpp CPU (`llama-server -ngl 0`), computed like `packages/webgllm/bench/tool-ref/llama_ref.py`: P(first token = `<tool_call>`) from the top-50 logprobs, greedy first token, and whether a 48-token greedy reply ever calls a tool.
- `kleval.sh`: `llama-perplexity` KL divergence / same top token / perplexity against saved reference logits (BF16, or the shipped QAD file for the head's own effect) on WikiText-2 test, the English chat corpus, Belebele and the BF16 chat replies in 16 languages. Runs on Metal.
- `memrun.sh`: llama.cpp's reported model buffers, peak RSS and peak memory footprint (`/usr/bin/time -l`) for a short completion, default (mmap + repacking) and flat (`-lm none -nr`).
- `benchcpu.sh`: interleaved `llama-bench` rounds on the CPU only (`-dev none`).
- `bench/`: wllama in headless Chromium (`macbench.mjs`, `page/index.html`, `serve.py`), the WebGL engine's tools.html in headless Chromium (`drive-page.mjs`, `webgl-ml.sh`).
- `gptq_head.py`: `cov` collects E[h hᵀ] of the final hidden states from a `llama-server --embeddings --pooling none`; `quant` writes a GPTQ-style Q4_0 head (error compensation with that full covariance).
- `headerr.py`: each head's plain and output-weighted error against a reference head, and the `<tool_call>` row's.
- `toolrow.py`: predicts each variant's P(`<tool_call>`) from the QAD model's hidden states with the variant's head swapped in (whole head, or only the `<tool_call>` row), to see where tool-score changes come from.
- `summarize.py`: everything into one table.
- `prompts/`: the multilingual prompt sets (model-written).

## Commands run

All on an Apple M3 Ultra (macOS), Nov 1, 2026, with the environment above; `H` is this folder. Other agents were running benchmarks on the same machine throughout.

```bash
# embeddings: QAD's own vs BF16 vs a fresh Q6_K
$PY -I $H/ggufhead.py $GGUF_PY src $QAD $BF16 $W/src/BF16-qadembF32.gguf
$BIN/llama-quantize --pure --token-embedding-type q6_K $BF16 $W/emb/bf16-Q6_K-none.gguf Q8_0 16
$BIN/llama-quantize --pure --token-embedding-type q6_K $W/src/BF16-qadembF32.gguf $W/emb/qad-Q6_K-none.gguf Q8_0 16
$BIN/llama-quantize --pure --token-embedding-type q4_0 $BF16 $W/emb/bf16-Q4_0-none.gguf Q8_0 16
$PY -I $H/ggufhead.py $GGUF_PY cmp $BF16 $QAD $W/emb/bf16-Q6_K-none.gguf $W/emb/qad-Q6_K-none.gguf $W/emb/bf16-Q4_0-none.gguf
$PY -I $H/ggufhead.py $GGUF_PY splice $QAD $QAD self.gguf && cmp self.gguf $QAD   # the writer reproduces the file byte for byte

# text
curl -sL -o $W/dl/belebele/<config>.jsonl https://huggingface.co/datasets/facebook/belebele/resolve/main/data/<config>.jsonl   # 16 configs, see prepdata.py
$PY -I $H/prepdata.py belebele $W/dl/belebele $W/text/belebele
$PY -I $H/prepdata.py wiki $TOKDIR/tokenizer.json $W/text/wikical 6000
$BIN/llama-server -m $BF16 --port 19412 -c 4096 -np 1 -ngl 99 &
$PY -I $H/genchat.py 19412 eval $W/text/mlchat
$PY -I $H/genchat.py 19412 cal ../lfm3-1.7b-web-gguf/scripts/calprompts.txt $W/text/cal-mlchat.txt
$PY -I $H/mkcal.py $TOKDIR $G/q/cal-mix.txt $W/text/wikical $W/text/cal-mlchat.txt $W/text/cal-ml.txt 8000

# importance matrices (from the QAD model and, for comparison, BF16) and the flat control
$BIN/llama-imatrix -m $QAD -f $W/text/cal-ml.txt -c 512 --process-output --parse-special -ngl 99 -o $W/imat/imatrix-ml-qad.gguf
$BIN/llama-imatrix -m $BF16 -f $W/text/cal-ml.txt -c 512 --process-output --parse-special -ngl 99 -o $W/imat/imatrix-ml-bf16.gguf
$PY -I $H/imatx.py $GGUF_PY flat $W/imat/imatrix-ml-qad.gguf $W/imat/imatrix-flat.gguf
$PY -I $H/imatx.py $GGUF_PY show $W/imat/imatrix-ml-qad.gguf $W/imat/imatrix-ml-bf16.gguf

# variants
$H/build_variants.sh none
IMAT=$W/imat/imatrix-ml-qad.gguf $H/build_variants.sh imat
IMAT=$W/imat/imatrix-flat.gguf $H/build_variants.sh flat Q4_0 Q4_K IQ4_XS IQ4_NL Q5_K Q5_0

# GPTQ-style Q4_0 head (full hidden-state covariance), damping 0.01 and 0.1
$BIN/llama-server -m $QAD --port 19426 -c 2048 -np 1 -ngl 99 --embeddings --pooling none &
$PY -I $H/gptq_head.py cov 19426 $TOKDIR/tokenizer.json $W/text/cal-ml.txt $W/imat/cov-qad.npz
$PY -I $H/gptq_head.py quant $GGUF_PY $QAD $W/imat/cov-qad.npz $W/emb/gptq-qad.gguf 0.01     # and 0.1 -> gptqd1
$PY -I $H/ggufhead.py $GGUF_PY splice $QAD $W/emb/gptq-qad.gguf $W/var/h-Q4_0-qad-gptq.gguf
$PY -I $H/ggufhead.py $GGUF_PY verify $QAD $W/var/h-Q4_0-qad-gptq.gguf
$PY -I $H/headerr.py $GGUF_PY $W/imat/cov-qad.npz $QAD $W/var/<variant>.gguf ...
$PY -I $H/toolrow.py $GGUF_PY 19426 $W/toolsets $QAD $W/var/<variant>.gguf ...   # same embeddings server

# tool scores (llama.cpp CPU)
$PY -I $H/mltools.py $TOKDIR $REF/tool_prompts.json $W/toolsets
TOOLDIR=tools-en $H/runtools.sh <name> <gguf> 19421 en      # every variant
$H/runtools.sh <name> <gguf> 19422                           # all 16 languages: QAD, BF16 and 20 variants

# KL (Metal), against BF16 and against the shipped QAD file
$H/kleval.sh base bf16 $BF16 && $H/kleval.sh base qad $QAD
$H/kleval.sh run bf16 qad-shipped $QAD
$H/kleval.sh run qad <name> $W/var/<name>.gguf      # every variant
$H/kleval.sh run bf16 <name> $W/var/<name>.gguf     # 21 variants

# memory and speed
$H/memrun.sh <name> <gguf> ...
ROUNDS=5 THREADS=4 $H/benchcpu.sh qad-shipped $QAD h-Q8_0-qad-none $W/var/h-Q8_0-qad-none.gguf ...   # one file per head type
python3 -I $H/bench/serve.py $W/page 19408 &     # page/index.html + wllama's ESM (packages/wllama/vendor/wllama -> esm/)
python3 -I $H/bench/serve.py $W/serve 19409 &    # the GGUFs + relaxed.wasm (packages/wllama/wasm/wllama-relaxed.wasm)
OUT=$W/bench/wllama.jsonl PW=<playwright-core>/index.js node $H/bench/macbench.mjs 3 2 qad-shipped.gguf h-Q8_0-qad-none.gguf ...

# the WebGL engine (packages/webgl), tools.html in headless Chromium (ANGLE Metal, Apple M3 Ultra)
MODELS_DIR=<GGUFs>/ REF_DIR=<toolcheck>/ref/ RESULTS_FILE=$W/webgl/results.jsonl node packages/webgllm/bench/server.mjs 19430 &
PW=... node $H/bench/drive-page.mjs "http://localhost:19430/tools.html?set=lfm3&runtime=webgl&format=gguf&model=<gguf>"
MODELS_DIR=<GGUFs>/ REF_DIR=$W/toolsets-webgl/ RESULTS_FILE=$W/webgl/results-ml.jsonl node packages/webgllm/bench/server.mjs 19431 &
PW=... $H/bench/webgl-ml.sh 19431 $W/webgl/ml LFM3-1.7B-QAD-Q4_0.gguf h-Q4_0-qad-imat.gguf h-Q4_0-qad-none.gguf h-Q8_0-qad-none.gguf
$PY -I $H/bench/webglsum.py $W/webgl/results-ml.jsonl

$PY -I $H/summarize.py $W $W/summary
```
