#!/bin/bash
# llama.cpp CPU memory per GGUF: model buffer sizes llama.cpp reports, peak RSS and peak memory footprint (/usr/bin/time -l),
# for a 16-token completion at n_ctx 4096, 4 threads, in two setups:
#   default:  mmap + weight repacking (what native llama.cpp does on this Mac)
#   flat:     --load-mode none --no-repack (all weights in one plain CPU buffer, closer to wllama, which has neither)
# usage: memrun.sh <name> <gguf> ...  (pairs)   output lines appended to $W/logs/mem.tsv
set -euo pipefail
mkdir -p "$W/logs"
while [ $# -ge 2 ]; do
  name=$1; model=$2; shift 2
  for setup in default flat; do
    extra=(); [ $setup = flat ] && extra=(-lm none -nr)
    log="$W/logs/mem-$name-$setup.log"
    /usr/bin/time -l "$BIN/llama-completion" -m "$model" -p "The capital of France is" -n 16 -ngl 0 -t 4 -c 4096 -no-cnv -lv 4 \
      ${extra[@]+"${extra[@]}"} > /dev/null 2> "$log"
    bufs=$(grep -a "model buffer size" "$log" | awk '{for(i=1;i<=NF;i++) if($i=="model") t[$(i-1)]+=$(i+4)} END{for(k in t) printf "%s=%.1f ", k, t[k]}')
    rss=$(grep -a "maximum resident set size" "$log" | awk '{printf "%.1f", $1/1048576}')
    foot=$(grep -a "peak memory footprint" "$log" | awk '{printf "%.1f", $1/1048576}')
    printf "%s\t%s\t%s\trssMiB=%s\tfootprintMiB=%s\n" "$name" "$setup" "$bufs" "$rss" "$foot" | tee -a "$W/logs/mem.tsv"
  done
done
