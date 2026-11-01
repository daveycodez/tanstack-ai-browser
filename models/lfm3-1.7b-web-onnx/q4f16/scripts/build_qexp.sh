#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
B="$P -I scripts/build_q.py out/gptq128_v80k/model_q4f16.onnx dl/onnx/model_fp16.onnx out/H"
$B out/q_bs256 '.':4:256 > out/q1.log 2>&1 &
$B out/q_2bit_4L 'layers\.(8|9|10|11)/mlp/':2:64 > out/q2.log 2>&1 &
$B out/q_2bit_8L 'layers\.([6-9]|1[0-3])/mlp/':2:64 > out/q3.log 2>&1 &
$B out/q_2bit_down8L 'layers\.([6-9]|1[0-3])/mlp/down':2:64 > out/q4.log 2>&1 &
wait
for v in gptq128_v80k q_bs256 q_2bit_4L q_2bit_8L q_2bit_down8L; do $P -I scripts/cpu_patch.py out/$v/model_q4f16.onnx out/$v/model_q4f16.cpu.onnx > /dev/null; done
grep -h 'data bytes' out/q?.log
