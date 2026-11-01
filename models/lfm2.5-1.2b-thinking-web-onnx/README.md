---
license: other
license_name: lfm1.0
license_link: LICENSE
base_model:
  - LiquidAI/LFM2.5-1.2B-Thinking
  - LiquidAI/LFM2.5-1.2B-Thinking-ONNX
library_name: transformers.js
pipeline_tag: text-generation
language:
  - en
  - ja
  - ko
  - fr
  - es
  - de
  - it
  - pt
  - ar
  - zh
tags:
  - onnx
  - webgpu
  - liquid
  - lfm2.5
  - thinking
  - reasoning
---

# LFM2.5-1.2B-Thinking ONNX for the web

A 4-bit ONNX build of [LFM2.5-1.2B-Thinking](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking) by [Liquid AI](https://www.liquid.ai/), made for in-browser use with [Transformers.js](https://github.com/huggingface/transformers.js) on WebGPU, including iPhone Safari.

This is an unofficial community build. It is not made, reviewed or endorsed by Liquid AI.

## Changes from the original

This repository contains a modified file. Compared with [LiquidAI/LFM2.5-1.2B-Thinking-ONNX](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-ONNX) at commit [`e7fe619`](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-ONNX/tree/e7fe61974e3a167dff77c5722db9a1cb7b57140f) (`onnx/model_q4f16.onnx`):

- **Logits only for the positions you need:** the graph has a new `num_logits_to_keep` input (int64 scalar), the same input [onnx-community/LFM3-1.7B-ONNX](https://huggingface.co/onnx-community/LFM3-1.7B-ONNX) has. The final-norm hidden states are sliced to the last `num_logits_to_keep` positions before the LM head; `0` keeps every position, as before. Transformers.js passes `1` during `generate()`, so reading a prompt computes one row of logits instead of one per prompt token. The `logits` output is `[batch, num_logits_to_keep, 65536]`, or `[batch, sequence_length, 65536]` for `0`.
- **Why:** the original graph returns float32 logits for every prompt token. For an 800-token prompt that is a 210 MB tensor (plus a 105 MB float16 one before the cast), made on the GPU and then copied to the page. On iPhone Safari, where a tab gets about 2 GB including GPU memory, long prompts such as ones with a tool definition crashed the tab.
- **Nothing else changed:** the edit adds three nodes (`Neg`, `Unsqueeze`, `Slice`), three small int64 constants and the input. The weights are not touched: `onnx/model_q4f16.onnx_data` is byte-identical to the original (SHA-256 `da02a690901817926fe4b8cda11e3fddc42604729dd4ce62c39df53a3ec2094d`).

`config.json`, `generation_config.json`, `tokenizer.json`, `tokenizer_config.json` and `chat_template.jinja` are unchanged copies. Only the q4f16 model is included.

| | Original q4f16 | This build |
|---|---|---|
| `logits` for an 800-token prompt | `[1, 800, 65536]`, 209,715,200 bytes | `[1, 1, 65536]`, 262,144 bytes |
| Last-token logits on 5 prompts of 18–963 tokens, max abs difference | | ≤ 0.0078 (logits up to ±16), same top token on every prompt |
| All positions (`num_logits_to_keep = 0`), max abs difference | | 0 |
| KV and conv caches after the prompt | | identical |
| 8 greedy decode steps after each prompt | | identical tokens and logits |
| 541-token tool prompt + 24 new tokens, Transformers.js 4.3.2 on WebGPU (Node, Apple Silicon) | about 251 ms | about 222 ms |
| 963-token prompt, onnxruntime CPU | 1,673 ms | 1,488 ms |

Measurements were taken with onnxruntime 1.31 on CPU unless noted. The small last-token difference comes from the LM head's 4-bit matmul running on one row instead of hundreds, which changes the order of the float16 sums. Through Transformers.js 4.3.2, greedy generation gave the same tokens with both builds.

## Usage

Use it like the original ONNX model, with `dtype: "q4f16"` and `device: "webgpu"`. See [LiquidAI/LFM2.5-1.2B-Thinking-ONNX](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-ONNX) for examples. Transformers.js sets `num_logits_to_keep` on its own. If you run the graph with onnxruntime directly, pass it as an int64 scalar: `1` for generation, `0` for all positions.

## License

LFM2.5 is released under the [LFM Open License v1.0](LICENSE), which also covers this build. Commercial use is licensed only for entities with annual revenue under $10 million. Original model © Liquid AI, Inc.
