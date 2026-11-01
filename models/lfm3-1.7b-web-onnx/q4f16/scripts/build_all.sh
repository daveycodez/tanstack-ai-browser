#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
B="$P -I scripts/build.py --src dl/onnx/model_q4f16.onnx --fp16 dl/onnx/model_fp16.onnx --rope 16384"
$B --bs 64 --out out/rope16k_bs64 > out/b64.log 2>&1 &
$B --bs 128 --out out/rope16k_bs128 > out/b128.log 2>&1 &
$B --bs 128 --keep-fused --out out/rope16k_bs128_keepfused > out/b128kf.log 2>&1 &
wait
for v in rope16k rope16k_bs64 rope16k_bs128 rope16k_bs128_keepfused; do $P -I scripts/cpu_patch.py out/$v/model_q4f16.onnx out/$v/model_q4f16.cpu.onnx; done
tail -n1 out/b64.log out/b128.log out/b128kf.log
