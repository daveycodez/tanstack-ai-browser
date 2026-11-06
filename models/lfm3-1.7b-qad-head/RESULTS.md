# Results: a smaller tied head for LFM3-1.7B QAD Q4_0

Apple M3 Ultra, Nov 1, 2026, llama.cpp `19cce69`. Every variant is Liquid AI's `LFM3-1.7B-QAD-Q4_0.gguf` with only `token_embd.weight` replaced: `ggufhead.py verify` found 286/286 other tensors and every metadata value byte-identical in all 52 files, and splicing the QAD file's own head back in reproduces the file byte for byte. Names are `h-<type>-<source>-<calibration>`. The source is `qad` (the QAD file's Q6_K head, dequantized) or `bf16` (Liquid's BF16 head). The calibration is `none`, `imat` (a multilingual importance matrix) or `flat` (a control matrix that is all ones).

Other agents were running benchmarks on this machine the whole time, so timings are noisy. Variants were interleaved across rounds, and each figure is a median with its min–max range.

## Main table

Speed and memory depend only on the head type, so variants of the same type share those numbers (measured on the `qad-imat` file of each type; Q6_K = the shipped file). "flat" memory means `-lm none -nr`: one plain CPU buffer, like wllama. llama-bench ran on the CPU only (`-dev none`), 4 threads, 5 rounds of 3 repetitions, pp512 / tg128. wllama ran in headless Chromium, 4 threads, the relaxed wasm, 3 rounds, 5 cached runs per file, with a 620-token prompt and 48 tokens written. The tool scores come from llama.cpp CPU (`llama-server -ngl 0`). KL is from `llama-perplexity` on Metal, n_ctx 512, scored on the second half of each chunk. BF16 itself scores PPL 22.69 on WikiText-2 and 2.953 on English chat by the same method.

| variant (type-source-cal) | file MB | head MB | buffer / RSS MiB (flat) | llama-bench tg (min–max) / pp t/s | wllama write (min–max) / read t/s | tool en: P, greedy, never | tool 15 langs: P, greedy, never (worst) | KL→BF16 Belebele mean (worst) | KL→BF16 ML chat mean (worst) | WikiText-2: KL / same-top % / PPL | EN chat: KL / same-top % / PPL | head-only KL vs QAD: wiki / Belebele / ML chat |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bf16 | 3,466.6 | 524.3 | 3298 / 3508 | — | — | 0.968, 20/20, 0 | 0.591, 204/300, 44 (de 8/20) | — | — | — | — | — / — / — |
| qad-shipped | 1,049.6 | 215.0 | 993 / 1203 | 97.3 (96.4–97.4) / 358 | 24.9 (24.7–24.9) / 47.6 | 0.965, 20/20, 0 | 0.740, 258/300, 22 (ja 14/20) | 0.2083 (0.358 th) | 0.1203 (0.183 th) | 0.2148 / 78.1 / 27.55 | 0.0789 / 89.2 / 3.19 | — / — / — |
| h-Q8_0-qad-none | 1,113.1 | 278.5 | 1054 / 1266 | 121.1 (114.3–122.3) / 358 | 24.3 (23.7–24.4) / 47.6 | 0.963, 20/20, 0 | 0.745, 260/300, 21 (ja 14/20) | 0.2088 (0.359 th) | 0.1199 (0.183 th) | 0.2143 / 78.1 / 27.54 | 0.0789 / 89.1 / 3.19 | 0.0003 / 0.0002 / 0.0002 |
| h-Q8_0-bf16-none | 1,113.1 | 278.5 | 1054 / 1266 | 121.1 (114.3–122.3) / 358 | 24.3 (23.7–24.4) / 47.6 | 0.961, 20/20, 0 | 0.732, 253/300, 24 (ja 13/20) | — | — | — | — | 0.0098 / 0.0070 / 0.0049 |
| h-Q6_K-bf16-none | 1,049.6 | 215.0 | 993 / 1203 | — | — | 0.961, 20/20, 0 | 0.734, 256/300, 21 (ja 14/20) | 0.2135 (0.364 th) | 0.1262 (0.200 de) | 0.2234 / 77.7 / 27.81 | 0.0837 / 88.8 / 3.21 | 0.0117 / 0.0082 / 0.0060 |
| h-Q5_1-qad-imat | 1,031.2 | 196.6 | 976 / 1184 | 85.8 (85.4–86.2) / 358 | 22.4 (22.0–22.5) / 47.7 | 0.971, 20/20, 0 | 0.780, 272/300, 16 (ja 16/20) | 0.2154 (0.369 th) | 0.1214 (0.189 th) | 0.2194 / 77.7 / 27.69 | 0.0816 / 89.1 / 3.19 | 0.0089 / 0.0068 / 0.0041 |
| h-Q5_K-qad-imat | 1,014.8 | 180.2 | 960 / 1166 | 99.6 (99.0–99.9) / 358 | 24.4 (23.9–24.4) / 47.6 | 0.963, 20/20, 0 | 0.757, 261/300, 22 (ja 14/20) | 0.2144 (0.368 th) | 0.1211 (0.189 th) | 0.2190 / 77.8 / 27.64 | 0.0785 / 89.1 / 3.18 | 0.0153 / 0.0069 / 0.0045 |
| h-Q5_K-bf16-imat | 1,014.8 | 180.2 | 960 / 1166 | 99.6 (99.0–99.9) / 358 | 24.4 (23.9–24.4) / 47.6 | 0.947, 20/20, 0 | 0.687, 242/300, 26 (ja 13/20) | 0.2139 (0.358 th) | 0.1251 (0.190 th) | 0.2185 / 77.8 / 27.63 | 0.0826 / 88.7 / 3.20 | 0.0126 / 0.0129 / 0.0087 |
| h-Q5_0-qad-imat | 1,014.8 | 180.2 | 960 / 1172 | 94.2 (94.0–94.4) / 358 | 22.9 (22.6–23.0) / 47.8 | 0.957, 20/20, 0 | 0.698, 245/300, 27 (ja 12/20) | 0.2164 (0.370 th) | 0.1254 (0.187 th) | 0.2197 / 77.9 / 27.60 | 0.0794 / 89.1 / 3.19 | 0.0110 / 0.0104 / 0.0067 |
| h-Q5_0-bf16-imat | 1,014.8 | 180.2 | 960 / 1172 | 94.2 (94.0–94.4) / 358 | 22.9 (22.6–23.0) / 47.8 | 0.960, 20/20, 0 | — | 0.2201 (0.371 th) | 0.1254 (0.189 th) | 0.2293 / 77.4 / 27.93 | 0.0867 / 88.7 / 3.22 | 0.0167 / 0.0159 / 0.0122 |
| h-Q4_1-qad-imat | 998.4 | 163.8 | 944 / 1156 | 97.1 (96.3–97.2) / 358 | 23.2 (23.1–23.2) / 47.5 | 0.965, 20/20, 0 | 0.774, 269/300, 17 (ja 15/20) | 0.2305 (0.385 th) | 0.1545 (0.245 de) | 0.2228 / 77.4 / 27.63 | 0.0919 / 88.6 / 3.23 | 0.0276 / 0.0268 / 0.0385 |
| h-Q4_K-qad-imat | 982.0 | 147.5 | 929 / 1142 | 106.7 (106.3–106.7) / 358 | 24.7 (24.7–24.8) / 47.8 | 0.969, 20/20, 0 | 0.757, 264/300, 16 (ja 14/20) | 0.2323 (0.392 th) | 0.1561 (0.241 th) | 0.2268 / 77.3 / 27.75 | 0.0904 / 88.7 / 3.22 | 0.0283 / 0.0270 / 0.0393 |
| h-Q4_K-qad-none | 982.0 | 147.5 | 929 / 1142 | 106.7 (106.3–106.7) / 358 | 24.7 (24.7–24.8) / 47.8 | 0.966, 20/20, 0 | 0.749, 264/300, 19 (ja 15/20) | 0.2341 (0.414 th) | 0.1689 (0.319 de) | 0.2401 / 76.6 / 28.15 | 0.0951 / 88.0 / 3.25 | 0.0327 / 0.0374 / 0.0466 |
| h-Q4_K-bf16-imat | 982.0 | 147.5 | 929 / 1142 | 106.7 (106.3–106.7) / 358 | 24.7 (24.7–24.8) / 47.8 | 0.978, 20/20, 0 | 0.797, 276/300, 15 (ja 17/20) | 0.2293 (0.390 th) | 0.1597 (0.240 de) | 0.2504 / 76.5 / 28.40 | 0.0868 / 88.2 / 3.21 | 0.0396 / 0.0350 / 0.0401 |
| h-IQ4_NL-qad-imat | 982.0 | 147.5 | 929 / 1142 | 106.2 (106.1–106.6) / 358 | 14.4 (14.3–14.5) / 47.5 | 0.983, 20/20, 0 | 0.804, 270/300, 22 (ja 16/20) | 0.2326 (0.394 th) | 0.1308 (0.206 th) | 0.2214 / 77.4 / 27.48 | 0.0908 / 88.5 / 3.24 | 0.0484 / 0.0315 / 0.0192 |
| h-IQ4_NL-bf16-imat | 982.0 | 147.5 | 929 / 1142 | 106.2 (106.1–106.6) / 358 | 14.4 (14.3–14.5) / 47.5 | 0.988, 20/20, 0 | 0.812, 271/300, 19 (de 16/20) | 0.2367 (0.405 th) | 0.1370 (0.242 de) | 0.2469 / 76.4 / 28.26 | 0.1032 / 87.6 / 3.31 | 0.0500 / 0.0363 / 0.0282 |
| h-IQ4_XS-qad-imat | 973.8 | 139.3 | 921 / 1132 | 99.8 (99.4–100.0) / 358 | 14.6 (14.4–14.6) / 47.6 | 0.982, 20/20, 0 | 0.796, 270/300, 20 (ja 15/20) | 0.2334 (0.399 th) | 0.1322 (0.208 th) | 0.2251 / 77.2 / 27.57 | 0.0938 / 88.3 / 3.26 | 0.0487 / 0.0337 / 0.0219 |
| h-IQ4_XS-bf16-imat | 973.8 | 139.3 | 921 / 1132 | 99.8 (99.4–100.0) / 358 | 14.6 (14.4–14.6) / 47.6 | 0.986, 20/20, 0 | 0.826, 273/300, 18 (ja 16/20) | 0.2382 (0.402 th) | 0.1381 (0.252 de) | 0.2505 / 76.3 / 28.32 | 0.1065 / 87.2 / 3.33 | 0.0505 / 0.0366 / 0.0303 |
| h-Q4_0-qad-imat | 982.0 | 147.5 | 929 / 1138 | 106.2 (106.2–106.5) / 358 | 24.8 (24.7–24.8) / 47.6 | 0.957, 20/20, 0 | 0.672, 244/300, 28 (de 13/20) | 0.2419 (0.413 th) | 0.1434 (0.293 de) | 0.2397 / 76.8 / 28.06 | 0.0851 / 88.2 / 3.21 | 0.0590 / 0.0361 / 0.0281 |
| h-Q4_0-qad-none | 982.0 | 147.5 | 929 / 1138 | 106.2 (106.2–106.5) / 358 | 24.8 (24.7–24.8) / 47.6 | 0.978, 20/20, 0 | 0.794, 271/300, 21 (ja 16/20) | 0.2482 (0.411 th) | 0.1499 (0.340 de) | 0.2371 / 76.8 / 27.79 | 0.1100 / 86.9 / 3.33 | 0.0610 / 0.0476 / 0.0335 |
| h-Q4_0-bf16-imat | 982.0 | 147.5 | 929 / 1138 | 106.2 (106.2–106.5) / 358 | 24.8 (24.7–24.8) / 47.6 | 0.969, 20/20, 0 | 0.756, 264/300, 24 (de 15/20) | 0.2432 (0.411 th) | 0.1465 (0.283 de) | 0.2322 / 76.9 / 27.69 | 0.0923 / 87.7 / 3.25 | 0.0661 / 0.0450 / 0.0315 |
| h-Q4_0-qad-gptq | 982.0 | 147.5 | 929 / 1138 | 106.2 (106.2–106.5) / 358 | 24.8 (24.7–24.8) / 47.6 | 0.980, 20/20, 0 | — | — | — | — | — | 0.0459 / 0.0469 / 0.0314 |

Table notes:

- **Tool scores:**
  - "tool en" is tools.html's 20 English prompts, token-identical to its LFM3 set.
  - "tool 15 langs" is the same 20 prompts in es, de, fr, it, pt, zh, ja, ko, ar, ru, hi, vi, th, id and pl: 300 prompts, with model-written translations in `prompts/tool_prompts_ml.json`.
  - "never" counts 48-token greedy replies with no `<tool_call>` at all.
- **KL corpora:**
  - Belebele means the FLORES passages of facebook/belebele: 488 per language, the first 60 × 512 tokens per language, 15,360 scored tokens each.
  - ML chat is 12 BF16 replies per language to native prompts (`prompts/chat_prompts_ml.json`): about 1.5–2.5k scored tokens per language, with a standard error of about ±0.005–0.01 per language.
  - WikiText-2 is the whole test set: 575 chunks, 147k scored tokens, standard error about ±0.001.
  - English chat is the previous build's 40 BF16 chat replies.
- **Head-only KL:** "head-only KL vs QAD" measures the same thing against the shipped QAD file's logits, so it shows the head swap's own damage. It uses 60 WikiText chunks, 20 Belebele chunks per language and all of the ML chat.
- **CPU check:** for three variants I repeated the head-only KL on pure CPU (`-dev none`). CPU reads 0.002–0.004 higher than Metal, because CPU quantizes activations to 8 bits, but the ranking is the same:

  | Variant | WikiText CPU / Metal | Belebele de CPU / Metal |
  |---|---|---|
  | Q5_K | 0.0179 / 0.0153 | 0.0089 / 0.0045 |
  | IQ4_NL | 0.0516 / 0.0484 | 0.0267 / 0.0227 |
  | Q4_0 | 0.0640 / 0.0590 | 0.0493 / 0.0479 |

- **Variants not in the table:**
  - All 20 `none`, 18 `imat` and 12 `flat` variants have English tool scores (every one 20/20, never-call 0, P 0.933–0.988) and head-only KL. They're in `$W/summary.md` / `summary.json`.
  - Q6_K re-quantized from QAD's own values reproduces the shipped file: head-only KL 0.0000, 99.94% same top token.

## QAD's embedding is not BF16's

The shipped Q6_K head is not a requantization of Liquid's BF16 head. Its relative error against BF16 is 2.35%, against 1.84% for a fresh Q6_K of BF16, and the two error patterns are almost unrelated: cos(QAD − BF16, fresh − BF16) = 0.19. The shipped head is 2.70% away from the fresh Q6_K, which is farther than either is from BF16. Every row moved by about the same amount (median 2.73%, p99 3.24%). Re-quantizing the dequantized QAD head to Q6_K gives back 90% of its rows bit for bit without an importance matrix, and KL 0.0000 with one. So Liquid's file is a llama.cpp Q6_K of a changed, QAD-trained embedding, probably quantized with an importance matrix.

The change matters: putting BF16's values back costs head-only KL 0.007 (Belebele) even at Q8_0, about as much as Q5_K of QAD's own values.

Against BF16, I compared the two sources over 6 types (Q5_K, Q5_0, Q4_K, IQ4_NL, IQ4_XS, Q4_0) × 4 corpora (WikiText, English chat, Belebele, ML chat):

- `qad` is better in 18 of the 24 comparisons, and 1 is a tie.
- `bf16` is better in 5:

  | Type | Corpus | `qad` | `bf16` |
  |---|---|---|---|
  | Q5_K | WikiText | 0.2190 | 0.2185 |
  | Q5_K | Belebele | 0.2144 | 0.2139 |
  | Q4_K | English chat | 0.0904 | 0.0868 |
  | Q4_K | Belebele | 0.2323 | 0.2293 |
  | Q4_0 | WikiText | 0.2397 | 0.2322 |

On the head-only screen, `qad` wins every pair.

## Importance matrix for a tied head

- **What llama-imatrix collects:** with `--process-output`, llama-imatrix records `token_embd.weight`, but only from the output matmul. The embedding lookup (`get_rows`) isn't a matmul, so it isn't seen. Without the flag the tensor is skipped, because the filter treats `token_embd.weight` as output.
- **What the importance is:** E[h²] per column of the final normed hidden state. Its diagonal matches the hidden-state covariance I collected separately (r = 1.0000). It is very skewed: max/median 82, and the top 1% of columns hold 20% of the importance.
- **Choice of model:** QAD-model and BF16-model matrices agree (r = 0.9998). Against the previous English-only matrix it is r = 0.69. I used the QAD model's matrix.
- **What llama-quantize does with it:** it looks the matrix up by tensor name and applies it to `token_embd` ("loaded 154 importance matrix entries" = 153 layer matrices + the head; the bytes change).
- **It helps every type:** head-only Belebele KL for the qad source drops 0.048 → 0.036 for Q4_0, 0.037 → 0.027 for Q4_K, 0.034 → 0.032 for IQ4_NL and 0.0083 → 0.0069 for Q5_K.
- **The values matter, not just the search:** the all-ones control is worse than the real matrix: Q4_0 0.040 vs 0.036, IQ4_NL 0.036 vs 0.032, IQ4_XS 0.040 vs 0.034.
- **The catch:** it only weights the output side, while the same rows also feed the network as embeddings.

## Tool calling

- **English:** every variant keeps 20/20, with no never-calls. That covers all 52 files plus 2 GPTQ files, on llama.cpp CPU, and the Q4_0 and Q8_0 heads on the WebGL engine. The test doesn't separate head variants.
- **Other languages:** the shipped QAD file itself gets 258/300 (P 0.740, 22 never-calls), and BF16 only 204/300 (P 0.591, 44 never-calls; de 8/20, ja 9/20). The misses are mostly calendar prompts, where the model wants a date, and replies that narrate before calling. So "20/20 everywhere" isn't reachable even for the shipped file. The bar used here is "no worse than QAD".
- **The multilingual score doesn't follow head precision:**

  | Variant | Score / 300 |
  |---|---|
  | Q4_K-bf16-imat | 276 |
  | IQ4_XS-bf16-imat | 273 |
  | Q5_1-qad-imat | 272 |
  | Q4_0-qad-none | 271 |
  | QAD | 258 |
  | Q5_0-qad-imat | 245 |
  | Q4_0-qad-imat | 244 |
  | Q5_K-bf16-imat | 242 |

  Each variant flips prompts almost all in one direction: Q4_K-bf16-imat gains 18 and loses 0, Q5_0-qad-imat gains 0 and loses 13.
- **Why, I think: the shared prompt.** I swapped each variant's head onto the QAD model's own hidden states (`toolrow.py`). That predicts P(`<tool_call>`) within ±0.025 of QAD for every variant, so the output side, including the `<tool_call>` row, doesn't explain the spread. What remains is the input side: all 320 prompts share the same ~280-token tool system prompt, and its re-rounded embeddings shift the model's readiness to call a tool for every prompt at once. In effect each variant draws one sample. I conclude, though didn't prove, that a lucky head here won't carry over to an app's own tool list.
- **The WebGL engine reproduces these per-variant scores:**

  | Variant | WebGL / 300 | llama.cpp CPU / 300 |
  |---|---|---|
  | QAD | 257 | 258 |
  | Q8_0-qad | 257 | 260 |
  | Q4_0-qad-imat | 246 | 244 |
  | Q4_0-qad-none | 269 | 271 |

  The shifts come from the weights, not from runtime noise.

## Memory

| head | file MB | llama.cpp flat buffer MiB | flat RSS MiB | default (mmap + repack) buffers MiB | default peak RSS / footprint MiB | wllama Chromium peak tree RSS MB |
|---|---|---|---|---|---|---|
| Q6_K (QAD) | 1,049.6 | 993.1 | 1203 | 206.6 mapped + 991.6 repack | 2187 / 1453 | 3261 |
| Q8_0 | 1,113.1 | 1053.7 | 1266 | 267.1 + 1052.2 | 2312 / 1516 | 3381 |
| Q5_1 | 1,031.2 | 975.5 | 1184 | 189.0 + 786.6 | 1963 / 1248 | 3222 |
| Q5_K | 1,014.8 | 959.9 | 1166 | 173.4 + 958.4 | 2121 / 1420 | 3192 |
| Q5_0 | 1,014.8 | 959.9 | 1172 | 173.4 + 786.6 | 1949 / 1248 | 3191 |
| Q4_1 | 998.4 | 944.3 | 1156 | 157.8 + 786.6 | 1932 / 1248 | 3163 |
| Q4_K, IQ4_NL, Q4_0 | 982.0 | 928.7 | 1138–1142 | 142.1 + 927.2 | 2058 / 1388 | 3127–3130 |
| IQ4_XS | 973.8 | 920.9 | 1132 | 134.3 + 786.6 | 1908 / 1247 | 3112 |

- **Native llama.cpp duplicates repackable heads:** with mmap and repacking (the default), heads whose type repacks for ARM (Q6_K, Q8_0, Q5_K, Q4_K, IQ4_NL, Q4_0) are held twice. One copy is mmapped for the embedding lookup; the other is a repacked copy for the output matmul. Q5_0, Q5_1, Q4_1 and IQ4_XS don't repack, so they are held once, and their private footprint is about 205 MiB lower than QAD's.
- **wllama has no mmap and no repacking:** there, the flat column is what counts. wllama's own log shows "CPU model buffer size = 993.13 MiB" for QAD.
- **Chromium's process tree peaks well above the model buffer, at 3.1–3.4 GB.** A 4.5-bit head lowers that peak by about 130 MB, roughly twice the head saving.

## Speed

- **Native CPU (llama-bench):** prompt speed is flat (358 t/s; only the last position needs the head). Writing depends on the type's dot-product kernel more than on its bytes, because at 4 threads this Mac is compute-bound, not bandwidth-bound:
  - Q8_0 is fastest: 121 vs 97.3 t/s (+24%), despite 30% more head bytes.
  - Q4_K, IQ4_NL and Q4_0: 106 (+9%).
  - Q5_K: 99.6 (+2%). IQ4_XS: 99.8 (+3%).
  - Q4_1: 97.1. Q5_0: 94.2 (−3%). Q5_1: 85.8 (−12%).
  - Run-to-run spread is ≤1 t/s, except Q8_0 (114–122).
- **wllama (WASM, 4 threads):** no head writes faster than the shipped Q6_K (24.9 t/s):
  - Q4_0 24.8, Q4_K 24.7, Q5_K 24.4, Q8_0 24.3: unchanged within noise.
  - Q4_1 23.2, Q5_0 22.9, Q5_1 22.4: −7% to −10%.
  - IQ4_NL 14.4, IQ4_XS 14.6: −42%. Their wasm kernels are much slower.
  - Read speed (47.6) and load time (1.1 s) are unchanged.

  On a bandwidth-starved phone a smaller head may help; this Mac can't show it.

## The WebGL engine

- **What its loader reads natively:** `packages/webgllm/src/load-gguf.ts` in the [webgllm repo](https://github.com/webgllm/webgllm) keeps a Q6_K head as it is, repacks a Q4_0 head (4-bit) or Q8_0 head (8-bit), and quantizes F16/F32 to 8 bits.
- **Q5_K and Q4_1 load, but bigger:** `rowsToFloats` dequantizes them, then they are stored at 8 bits, which is larger than the shipped Q6_K.
- **The other types don't load at all:** Q5_0, Q5_1, Q4_K, IQ4_NL and IQ4_XS make `rowsToFloats` throw "can't convert".
- **Runs as-is:** I ran tools.html in headless Chromium on a real GPU ("ANGLE Metal Renderer: Apple M3 Ultra"):

  | Head | English: P, greedy, never | Other languages: greedy, P, never |
  |---|---|---|
  | QAD as shipped | 0.960, 20/20, 0 | 257/300, P 0.737, 22 never |
  | Q4_0-qad-imat | 0.957, 20/20, 0 | 246/300, P 0.690, 29 never |
  | Q4_0-qad-none | 0.976, 20/20, 0 | 269/300 |
  | Q8_0-qad | 0.961, 20/20, 0 | 257/300 |

  The Q4_0 head loaded in 3.9 s.
- **What each other type would need:**
  - IQ4_NL is the cheapest addition. Its block is the same as Q4_0's (fp16 scale + 16 bytes of nibbles); only the decode differs, a 16-entry table instead of q − 8. It is the best 4.5-bit head on ML chat and WikiText, but wllama's kernel for it is slow.
  - Q5_0 is Q4_0 plus a 32-bit plane of high bits per block.
  - Q4_K and Q5_K need 256-wide super-blocks with 6-bit sub-scales and mins, close to the Q6_K path it already has.
  - IQ4_XS is IQ4_NL in super-blocks.

## GPTQ-style Q4_0 (negative)

The only 4.5-bit head the engine reads natively is Q4_0, and it's the worst 4.5-bit type, so I tried a GPTQ-style Q4_0 (`gptq_head.py`). It compensates rounding error with the full hidden-state covariance (164,877 calibration tokens), still in llama.cpp's Q4_0 format.

On the output side it reaches Q4_K's error: output-weighted 0.00129, against 0.00193 for Q4_0-imat and 0.00130 for Q4_K-imat. But its plain error rises from 8.7% to 10.2%, and the same rows are the input embedding. The result is worse overall: head-only KL Belebele 0.047 vs 0.036 and English chat 0.025 vs 0.014. Only WikiText improves, 0.046 vs 0.059. Damping 0.1 doesn't fix it (0.044 Belebele). English tool score is 20/20.

## What wasn't measured

- Phones or other bandwidth-limited devices (this Mac only).
- wllama tool scores (wllama is llama.cpp's CPU code, so llama.cpp CPU stands in).
- KL against BF16 for 31 of the 54 variants: they were screened head-only against QAD.
- Multilingual tool scores for 32 variants.
- WebGL timing.
