#!/bin/bash
G="$(cd "$(dirname "$0")" && pwd)"
ADB=${ADB:-adb}; S=${ANDROID_SERIAL:?set ANDROID_SERIAL to the phone adb serial}
ROUNDS=${ROUNDS:-4}; MAXT=${MAXT:-360}; R0=${R0:-10}
V=("base LFM3-1.7B-Q4_K_M.gguf" "trimq4 n7b-trim-Q4_K-imix.gguf" "s v2-Q4_K_S.gguf" "trimq6 n8-trim-Q4_K-embQ6-imix.gguf" "pure v7-Q4_K-pure-imat.gguf" "embq6 v8-Q4_K-embQ6-imat.gguf")
n=${#V[@]}
for r in $(seq 0 $((ROUNDS-1))); do
  for k in $(seq 0 $((n-1))); do
    idx=$(( (k + r) % n ))
    for w in $(seq 1 24); do
      t=$($ADB -s $S shell dumpsys battery | awk '/temperature/{print $2}')
      idle=$($ADB -s $S shell top -b -n 1 -m 1 | grep -o '[0-9]*%idle' | tr -d '%idle')
      [ "$t" -le "$MAXT" ] && [ "${idle:-0}" -ge 650 ] && break
      sleep 10
    done
    echo "round $((r+R0)) start ${V[$idx]} temp $t idle $idle"
    $G/qbench.sh r$((r+R0))-${V[$idx]% *} ${V[$idx]#* } ${RUNS:-1}
  done
done
echo ALLDONE
