#!/bin/bash
# Build head variants: Liquid's QAD Q4_0 GGUF with only token_embd.weight replaced.
# usage: build_variants.sh <cal: none, or a name for the importance matrix in $IMAT (imat, flat)> [types...]
# env: BIN (llama.cpp bin), GGUF_PY, PY (python with numpy), QAD, BF16 (Liquid's files), W (work dir),
#      IMAT (importance matrix, for cal != none). Needs $W/src/BF16-qadembF32.gguf from `ggufhead.py src`.
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
cal=$1; shift
TYPES=${*:-"Q8_0 Q6_K Q5_K Q5_1 Q5_0 Q4_K Q4_1 IQ4_NL IQ4_XS Q4_0"}
mkdir -p "$W/emb" "$W/var" "$W/logs"
for src in bf16 qad; do
  in=$BF16; [ $src = qad ] && in=$W/src/BF16-qadembF32.gguf
  for t in $TYPES; do
    [ $cal != none ] && [ $t = Q8_0 ] && continue   # Q8_0 ignores the importance matrix
    name=h-$t-$src-$cal
    [ -f "$W/var/$name.gguf" ] && continue
    extra=(); [ $cal != none ] && extra=(--imatrix "$IMAT")
    # Every other tensor goes to Q8_0 here; only token_embd is kept from this file.
    "$BIN/llama-quantize" --pure --token-embedding-type "$t" ${extra[@]+"${extra[@]}"} "$in" "$W/emb/$name.gguf" Q8_0 16 > "$W/logs/q-$name.log" 2>&1
    "$PY" -I "$H/ggufhead.py" "$GGUF_PY" splice "$QAD" "$W/emb/$name.gguf" "$W/var/$name.gguf"
    "$PY" -I "$H/ggufhead.py" "$GGUF_PY" verify "$QAD" "$W/var/$name.gguf" | sed "s/^/$name /" | tee -a "$W/logs/verify.txt"
    rm "$W/emb/$name.gguf"
  done
done
