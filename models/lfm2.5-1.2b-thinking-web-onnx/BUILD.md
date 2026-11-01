# Building LFM2.5-1.2B-Thinking-Web-ONNX

The source is [LiquidAI/LFM2.5-1.2B-Thinking-ONNX](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-ONNX) at commit `e7fe61974e3a167dff77c5722db9a1cb7b57140f`. Both builds edit the graph only. The weights files are Liquid's, unchanged. See the [model card](README.md) for details.

Run from this folder (see [the setup](../README.md#setup) for the venv):

```bash
hf download LiquidAI/LFM2.5-1.2B-Thinking-ONNX --revision e7fe61974e3a167dff77c5722db9a1cb7b57140f --local-dir dl/liquid \
  --include "onnx/model_q4.onnx*" "onnx/model_q4f16.onnx*" README.md LICENSE chat_template.jinja "tokenizer*" config.json generation_config.json
mkdir -p out/onnx
```

## q4f16 (WebGPU)

This adds a `num_logits_to_keep` input, so reading a prompt computes logits for its last token only. The output was checked byte-identical to the published graph:

```bash
venv/bin/python -I scripts/add_num_logits_to_keep.py dl/liquid/onnx/model_q4f16.onnx out/onnx/model_q4f16.onnx
cp dl/liquid/onnx/model_q4f16.onnx_data out/onnx/
```

## q4 (WebAssembly)

This makes the same edit, and also replaces the `GatherBlockQuantized` embedding lookup with standard ops, which onnxruntime-web 1.31.1's WebGPU-enabled WebAssembly builds can run:

```bash
scripts/build.sh out/onnx/model_q4.onnx
cp dl/liquid/onnx/model_q4.onnx_data out/onnx/
```

Copy the tokenizer and config files from `dl/liquid/` next to `out/onnx/` unchanged.

## Checking

- `diff_graphs.py`: shows what changed between two graphs.
- `check_embedding_exhaustive.py`: compares the new embedding lookup with the original for every token id.
- `prompts.py`, `verify_python.py`, `check_wasm_vs_python.py`: logits and decoding compared with the original, on onnxruntime CPU and on WebAssembly.
- `make_gbq_probe.py`, `make_mnb_bench.py`, `node/`: single-op probes and timings on onnxruntime-web.
