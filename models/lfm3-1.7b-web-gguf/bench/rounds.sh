#!/bin/bash
# Interleaved rounds with a battery-temperature cooldown before each launch.
G="$(cd "$(dirname "$0")" && pwd)"
ADB=${ADB:-adb}; S=${ANDROID_SERIAL:?set ANDROID_SERIAL to the phone adb serial}
ROUNDS=${ROUNDS:-4}; MAXT=${MAXT:-360}
V=("base LFM3-1.7B-Q4_K_M.gguf" "s v2-Q4_K_S.gguf" "pure v7-Q4_K-pure-imat.gguf" "embq6 v8-Q4_K-embQ6-imat.gguf")
n=${#V[@]}
for r in $(seq 0 $((ROUNDS-1))); do
  for k in $(seq 0 $((n-1))); do
    idx=$(( (k + r) % n ))
    for w in $(seq 1 24); do
      t=$($ADB -s $S shell dumpsys battery | awk '/temperature/{print $2}')
      [ "$t" -le "$MAXT" ] && break
      sleep 10
    done
    echo "round $r start ${V[$idx]} temp $t thermal $($ADB -s $S shell dumpsys thermalservice | grep -m1 "Thermal Status")"
    $G/qbench.sh r$r-${V[$idx]% *} ${V[$idx]#* } ${RUNS:-1}
  done
done
echo ALLDONE
