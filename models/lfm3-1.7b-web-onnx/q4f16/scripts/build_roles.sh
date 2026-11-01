#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
B="$P -I scripts/build.py --src dl/onnx/model_q4f16.onnx --fp16 dl/onnx/model_fp16.onnx --rope 16384 --no-embed --bs 128"
for r in gate_proj up_proj conv/in_proj conv/out_proj attn/out_proj; do
  n=r128_$(echo $r | tr '/' '_'); $B --roles $r --out out/$n > out/$n.log 2>&1 &
done
$B --roles q_proj,k_proj,v_proj --out out/r128_qkv > out/r128_qkv.log 2>&1 &
wait
for d in out/r128_*/; do $P -I scripts/cpu_patch.py $d/model_q4f16.onnx $d/model_q4f16.cpu.onnx > /dev/null; done
grep -h wrote out/r128_*.log
