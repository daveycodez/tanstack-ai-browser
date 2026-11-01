#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
B="$P -I scripts/build.py --src dl/onnx/model_q4f16.onnx --fp16 dl/onnx/model_fp16.onnx --rope 16384"
$B --bs 32 --out out/abl_bs32clip > out/a1.log 2>&1 &
$B --bs 64 --rtn --out out/abl_bs64rtn > out/a2.log 2>&1 &
$B --embed-bs 128 --embed-only --out out/abl_emb128 > out/a3.log 2>&1 &
wait
$B --embed-bs 128 --embed-only --rtn --out out/abl_emb128rtn > out/a4.log 2>&1 &
$B --bs 128 --no-embed --out out/abl_bs128_noemb > out/a5.log 2>&1 &
$B --bs 128 --no-embed --roles down_proj --out out/abl_down128 > out/a6.log 2>&1 &
wait
for v in abl_bs32clip abl_bs64rtn abl_emb128 abl_emb128rtn abl_bs128_noemb abl_down128; do $P -I scripts/cpu_patch.py out/$v/model_q4f16.onnx out/$v/model_q4f16.cpu.onnx >/dev/null; done
grep -h wrote out/a?.log
