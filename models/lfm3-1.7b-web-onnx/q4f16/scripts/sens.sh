#!/bin/bash
# Per-layer 2-bit sensitivity: requantize one layer's MLP (gate/up/down) to 2-bit GPTQ bs64 on the full-vocab
# gptq128 model, measure WikiText KL vs fp16 (8,176 tokens), delete the build.  Output: out/sens/layer<i>.json
cd "$(dirname "$0")/.."
P=venv/bin/python; mkdir -p out/sens
one() {
  i=$1; d=out/sens/L$i
  $P -I scripts/build_q.py out/gptq128_nodup/model_q4f16.onnx dl/onnx/model_fp16.onnx out/H $d "layers\.$i/mlp/":2:64 > $d.log 2>&1 &&
  $P -I scripts/cpu_patch.py $d/model_q4f16.onnx $d/model_q4f16.cpu.onnx > /dev/null &&
  $P -I scripts/wikippl.py dl dl/wikitext/wikitext-2-raw-v1/test-00000-of-00001.parquet out/wiki_ref.npy L$i $d/model_q4f16.cpu.onnx 16 2>/dev/null | grep '^{' > out/sens/layer$i.json
  rm -rf $d
}
for i in $(seq 0 23); do one $i & if [ $(( (i+1) % 6 )) -eq 0 ]; then wait; fi; done; wait
cat out/sens/layer*.json
