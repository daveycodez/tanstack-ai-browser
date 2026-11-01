#!/bin/bash
cd "$(dirname "$0")/.."
P=venv/bin/python
K=out/vocab49152/keep_ids.json
# 48k vocab on the block-128 GPTQ model
$P -I scripts/vocab_model.py out/gptq128_nodup/model_q4f16.onnx $K out/v48k > out/t_v48k.log 2>&1
BQ="$P -I scripts/build_q.py out/v48k/model_q4f16.onnx dl/onnx/model_fp16.onnx out/H"
L6='layers\.(9|8|10|12|7|11)/mlp/'
L15='layers\.(9|8|10|12|7|11|6|13|5|15|4|16|17|18|14)/mlp/'
L24='layers\.[0-9]+/mlp/'
$BQ out/t750 "$L6":2:64 '.':4:256 > out/t750.log 2>&1 &
$BQ out/t650 "$L15":2:64 '.':4:256 > out/t650.log 2>&1 &
$BQ out/t550 "$L24":2:64 '.':4:256 > out/t550.log 2>&1 &
# block-32 (wide-tile prefill + fused decode) family at 48k
( $P -I scripts/build.py --src dl/onnx/model_q4f16.onnx --fp16 dl/onnx/model_fp16.onnx --rope 16384 --gptq out/H --bs 32 --keep-fused --fused-sym32 --out out/g32tmp > out/b32b.log 2>&1 &&
  mkdir -p out/g32tmp_nd && mv out/g32tmp/model_q4f16.onnx_data out/g32tmp_nd/ && $P -I scripts/nodedup.py out/g32tmp/model_q4f16.onnx out/g32tmp_nd/model_q4f16.onnx > /dev/null &&
  $P -I scripts/vocab_model.py out/g32tmp_nd/model_q4f16.onnx $K out/f32_v48k > /dev/null && rm -rf out/g32tmp out/g32tmp_nd ) &
wait
for v in v48k t750 t650 t550 f32_v48k; do $P -I scripts/cpu_patch.py out/$v/model_q4f16.onnx out/$v/model_q4f16.cpu.onnx > /dev/null; done
ls -l out/{v48k,t750,t650,t550,f32_v48k}/model_q4f16.onnx_data
