#!/bin/bash
# llama-bench on the CPU only (-dev none, so no Metal op offload): prompt 512 and 128 generated tokens, 3 repetitions per launch,
# ROUNDS rounds with the file order rotated each round. Appends llama-bench's JSON lines (plus "name") to $W/bench/llama-bench.jsonl.
# usage: benchcpu.sh <name> <gguf> ...  (pairs)      env: BIN, W, ROUNDS (default 5), THREADS (default 4)
set -euo pipefail
mkdir -p "$W/bench"
names=(); files=()
while [ $# -ge 2 ]; do names+=("$1"); files+=("$2"); shift 2; done
n=${#names[@]}
for r in $(seq 0 $(( ${ROUNDS:-5} - 1 ))); do
  for k in $(seq 0 $((n - 1))); do
    i=$(( (k + r) % n ))
    "$BIN/llama-bench" -m "${files[$i]}" -dev none -ngl 0 -t ${THREADS:-4} -p 512 -n 128 -r 3 -o jsonl 2> /dev/null \
      | python3 -I -c "import sys,json
for l in sys.stdin:
    d=json.loads(l); d['name']='${names[$i]}'; d['round']=$r; print(json.dumps(d))" | tee -a "$W/bench/llama-bench.jsonl" \
      | python3 -I -c "import sys,json
for l in sys.stdin:
    d=json.loads(l); print(d['round'], d['name'], 'pp' if d['n_prompt'] else 'tg', round(d['avg_ts'],1))"
  done
done
