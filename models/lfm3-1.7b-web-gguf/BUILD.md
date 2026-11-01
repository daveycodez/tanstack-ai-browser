# Building LFM3-1.7B-Web-GGUF

One file, `LFM3-1.7B-Web-Q4_K.gguf` (SHA-256 `100ac96303b62e1e…`), made on Oct 30–31, 2026 from Liquid AI's BF16 GGUF, [LiquidAI/LFM3-1.7B-GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) `LFM3-1.7B-BF16.gguf` (SHA-256 `39158a79f56edb85…`). See the [model card](README.md) for what changed and the measurements.

It needs llama.cpp at commit `19cce69` (the commit wllama builds), built natively for `llama-imatrix`, `llama-quantize`, `llama-perplexity` and `llama-server`, and its `gguf-py` for `trimvocab.py`. Run from this folder, with a venv holding `numpy` and `tokenizers` (see [the setup](../README.md#setup)).

## 1. Downloads

```bash
hf download LiquidAI/LFM3-1.7B-GGUF LFM3-1.7B-BF16.gguf LFM3-1.7B-Q4_K_M.gguf --local-dir dl
hf download daveycodez/LFM3-1.7B-Web-ONNX tokenizer.json tokenizer_config.json --local-dir web
hf download LiquidAI/LFM3-1.7B tokenizer.json tokenizer_config.json --local-dir orig
```

`web/` holds the trimmed tokenizer, shared with [LFM3-1.7B-Web-ONNX](../lfm3-1.7b-web-onnx), where `vocab_trim.py` picked its 49,152 rows. Put WikiText-2 raw (`wiki.train.raw`, `wiki.test.raw`) in `wt/wikitext-2-raw/`.

## 2. Vocabulary

`trimvocab.py` keeps the embedding / LM-head rows of the tokens in `web/tokenizer.json`, in its order, and rewrites the GGUF's tokenizer (tokens, scores, types, merges, special token ids) to match:

```bash
mkdir -p out q
venv/bin/python -I scripts/trimvocab.py <llama.cpp>/gguf-py dl/LFM3-1.7B-BF16.gguf web/tokenizer.json out/LFM3-1.7B-BF16-trim.gguf
```

## 3. Importance matrix

The calibration text is the first 92,000 bytes of WikiText-2's training split plus chat replies the BF16 model writes to the prompts in `scripts/calprompts.txt`. The matrix comes from the untrimmed BF16 model, output layer included. Its values are per input column, so they apply to the trimmed model's 49,152 rows too.

```bash
<llama.cpp>/build/bin/llama-server -m dl/LFM3-1.7B-BF16.gguf --port 8091 -c 4096 -np 1 -ngl 99 &
python3 -I scripts/gencal.py 8091 q/cal-chat.txt scripts/calprompts.txt
kill %1
head -c 92000 wt/wikitext-2-raw/wiki.train.raw > q/cal-mix.txt && cat q/cal-chat.txt >> q/cal-mix.txt
<llama.cpp>/build/bin/llama-imatrix -m dl/LFM3-1.7B-BF16.gguf -f q/cal-mix.txt -c 512 --process-output -o q/imatrix-mix.gguf
```

## 4. Quantize

This uses Q4_K for every layer matrix (`--pure`, so no Q6_K/Q5_K mix as in Q4_K_M), with the tied embedding / LM head at Q6_K:

```bash
<llama.cpp>/build/bin/llama-quantize --imatrix q/imatrix-mix.gguf --pure --token-embedding-type q6_K --output-tensor-type q6_K \
  out/LFM3-1.7B-BF16-trim.gguf out/LFM3-1.7B-Web-Q4_K.gguf Q4_K_M
```

`scripts/ggufparse.py` lists a GGUF's tensors by type and size.

## Checking

Each script below takes a running `llama-server`'s port:

- `toolcheck20.py <port> bench/exa <think 0|1>`: 20 prompts that should get a direct call to Exa's search or fetch tool (`bench/exa/tools.json`).
- `chatcheck.py <port>`: a few chats (tool calls, thinking, math), as JSON lines; `summ.py` summarizes them.
- `tokcheck.py <port> web/tokenizer.json`: the server's tokenization against the trimmed tokenizer.
- `promptcount.py <full port> <trim port> bench/exa <files…>`: how many tokens prompts take with each vocabulary. It also needs `bench/exa/search_result.txt`, a saved Exa search result, which isn't kept here: save any search result's text there.
- `gencorpus.py <port> <out>`: chat replies for perplexity on chat text.

Perplexity uses `llama-perplexity -m <gguf> -f <text> -c 512 -b 512 --ppl-stride 256`, scored per original token for the trimmed builds: the card multiplies log-perplexity by the token-count ratio, 297,470 / 294,644 on WikiText and 14,879 / 14,646 on the chat corpus.

Speed:
- `bench/macbench.mjs <rounds> <runs> <files…>` times wllama in headless Chromium (`npm install playwright-core` beside it). It needs the page in `bench/page/` served on port 3008, with wllama's ESM build copied to `bench/page/esm/` from `packages/wllama/vendor/wllama/`, and the GGUFs and `relaxed.wasm` (`packages/wllama/wasm/wllama-relaxed.wasm`) served on port 3009.
- `bench/qbench.sh` and `bench/rounds*.sh` run the same page in Firefox on an Android phone, with `ANDROID_SERIAL` set, `adb reverse` for ports 3008, 3009 and 3999, and `bench/relay.py` logging the page's results to `RELAY_LOG`.

## Experiments

Each was built with the same `llama-quantize` from the BF16 GGUF unless noted. Only `n8` was published.

| Build | Recipe |
|---|---|
| v2 | Q4_K_S |
| v3, v4 | Q4_K `--pure`; v4 with a Q6_K embedding / head |
| v5, v6 | the same from Liquid AI's QAD Q4_0 (`--allow-requantize`) |
| v7, v8, v9 | with an importance matrix from WikiText-2 training text only (`llama-imatrix … --chunks 200`): `--pure`, Q6_K embedding, plain Q4_K_M |
| n6, n6b | the mixed importance matrix (step 3), untrimmed: `--pure`, Q6_K embedding |
| n7 | trimmed, `--pure`, Q4_K embedding (886 MB) |
| **n8** | trimmed, `--pure`, Q6_K embedding: the published file |
