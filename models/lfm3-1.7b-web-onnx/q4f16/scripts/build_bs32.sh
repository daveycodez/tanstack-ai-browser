#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
$P -I scripts/build.py --src dl/onnx/model_q4f16.onnx --fp16 dl/onnx/model_fp16.onnx --rope 16384 --gptq out/H --bs 32 --keep-fused --fused-sym32 --out out/gptq32kf > out/b32.log 2>&1
mkdir -p out/gptq32kf_nodup && mv out/gptq32kf/model_q4f16.onnx_data out/gptq32kf_nodup/ && $P -I scripts/nodedup.py out/gptq32kf/model_q4f16.onnx out/gptq32kf_nodup/model_q4f16.onnx
$P -I scripts/vocab_model.py out/gptq32kf_nodup/model_q4f16.onnx out/vocab81920/keep_ids.json out/gptq32_v80k
$P -I scripts/cpu_patch.py out/gptq32_v80k/model_q4f16.onnx out/gptq32_v80k/model_q4f16.cpu.onnx
rm -rf out/gptq32kf out/gptq32kf_nodup
ls -l out/gptq32_v80k
