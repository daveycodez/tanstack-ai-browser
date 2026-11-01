#!/bin/bash
# Rebuilds out/onnx/model_q4.onnx from Liquid's model_q4.onnx (LiquidAI/LFM2.5-1.2B-Thinking-ONNX @ e7fe619).
set -euo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
"$W/venv/bin/python" -I "$W/scripts/add_num_logits_to_keep.py" "$W/dl/liquid/onnx/model_q4.onnx" "$T/step1.onnx"
"$W/venv/bin/python" -I "$W/scripts/replace_gather_block_quantized.py" "$T/step1.onnx" "$1"
rm -rf "$T"
