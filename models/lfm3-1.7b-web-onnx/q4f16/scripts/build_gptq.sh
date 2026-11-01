#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
B="$P -I scripts/build.py --src dl/onnx/model_q4f16.onnx --fp16 dl/onnx/model_fp16.onnx --rope 16384 --gptq out/H"
$B --bs 128 --out out/gptq128 > out/g1.log 2>&1 &
$B --bs 128 --no-embed --out out/gptq128_emb32 > out/g2.log 2>&1 &
$B --bs 128 --keep-fused --fused-sym32 --out out/gptq_keepfused > out/g3.log 2>&1 &
$B --bs 64 --out out/gptq64 > out/g4.log 2>&1 &
wait
for v in gptq128 gptq128_emb32 gptq_keepfused gptq64; do $P -I scripts/cpu_patch.py out/$v/model_q4f16.onnx out/$v/model_q4f16.cpu.onnx >/dev/null; done
grep -h wrote out/g?.log
