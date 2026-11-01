#!/bin/bash
# GPU-side measurements per build (sequential): memory (1.31.0-dev, default cache, one pass, +64 tokens),
# prefill GPU time / longest submit, WebGPU-vs-CPU agreement (ort-node), tool-call greedy check (CPU).
S="$(cd "$(dirname "$0")/.." && pwd)"; cd "$S"
export PRESENT_NAMES=$S/out/present_names.json ORTDIR=ortweb_dev
mkdir -p out/m
for spec in "$@"; do
  IFS=: read n d t <<< "$spec"
  for P in 512 1024 2048; do (cd nodetest && node prefill.mjs $S/out/$d/model_q4f16.onnx $P 0 default /dev/null 64 2>/dev/null | grep '^{' | sed "s/^{/{\"build\":\"$n\",/") >> out/m/mem.jsonl; done
  for P in 343 1024 2048; do (cd nodetest && node diag.mjs $S/out/$d/model_q4f16.onnx $P $PRESENT_NAMES 16 2>/dev/null | grep '^{' | sed "s/^{/{\"build\":\"$n\",/") >> out/m/diag.jsonl; done
  venv/bin/python -I scripts/dump_traj.py out/$t out/$d/model_q4f16.cpu.onnx out/m/traj_$n.json
  EOS=$(venv/bin/python -I -c "from tokenizers import Tokenizer; print(Tokenizer.from_file('out/$t/tokenizer.json').token_to_id('<|im_end|>'))")
  (cd nodetest && node run.mjs $S/out/$d/model_q4f16.onnx $S/out/m/traj_$n.json $S/out/m/wg_$n.bin webgpu $EOS > $S/out/m/wg_$n.json 2>/dev/null)
  venv/bin/python -I scripts/cmp_final.py $S $n out/$d/model_q4f16.cpu.onnx out/$t out/m/traj_$n.json out/m/wg_$n >> out/m/webgpu.jsonl
  venv/bin/python -I scripts/toolcall_check.py $S $n=out/$d/model_q4f16.cpu.onnx=out/$t > out/m/tool_$n.txt 2>/dev/null
  echo "done $n"
done
