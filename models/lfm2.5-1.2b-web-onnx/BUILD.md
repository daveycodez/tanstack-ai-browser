# Building LFM2.5-1.2B-Web-ONNX

The source is [LiquidAI/LFM2.5-1.2B-Instruct-ONNX](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX) at commit `10f72e70abf67ac0fd7ebf15bc5854726891d864`. Both builds edit the graph only. The weights files are Liquid's, unchanged. See the [model card](README.md) for details.

Run from this folder (see [the setup](../README.md#setup) for the venv):

```bash
hf download LiquidAI/LFM2.5-1.2B-Instruct-ONNX --revision 10f72e70abf67ac0fd7ebf15bc5854726891d864 --local-dir dl/liquid \
  onnx/model_q4.onnx onnx/model_q4.onnx_data onnx/model_q4f16.onnx onnx/model_q4f16.onnx_data \
  README.md LICENSE chat_template.jinja config.json generation_config.json tokenizer.json tokenizer_config.json
mkdir -p out/onnx
```

## q4f16 (WebGPU)

This adds a `num_logits_to_keep` input, so reading a prompt computes logits for its last token only:

```bash
venv/bin/python -I scripts/add_num_logits_to_keep.py dl/liquid/onnx/model_q4f16.onnx out/onnx/model_q4f16.onnx
cp dl/liquid/onnx/model_q4f16.onnx_data out/onnx/
```

## q4 (WebAssembly)

This makes the same edit, and also rebuilds the `GatherBlockQuantized` embedding lookup from standard ops, which onnxruntime-web 1.31.1's WebGPU-enabled WebAssembly builds can run:

```bash
venv/bin/python -I scripts/build_q4.py dl/liquid/onnx/model_q4.onnx out/onnx/model_q4.onnx
cp dl/liquid/onnx/model_q4.onnx_data out/onnx/
```

Copy the tokenizer and config files from `dl/liquid/` next to `out/onnx/` unchanged.

## Checking

- `diff_graphs.py`: shows what changed between two graphs.
- `check_embed.py`: compares the new embedding lookup with `GatherBlockQuantized` for every token id.
- `make_prompts.py`, then `verify_py.py`: logits, caches and greedy decoding compared with the original on onnxruntime CPU.
- `node/test/`: onnxruntime-web WebAssembly load and decode checks and timings.
