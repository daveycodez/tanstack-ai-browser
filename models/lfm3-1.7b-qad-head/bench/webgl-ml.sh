#!/bin/bash
# tools.html (packages/webgl/bench) on the WebGL engine for each language set, per GGUF.
# usage: webgl-ml.sh <bench server port> <out dir> <gguf basename> ...     (server: REF_DIR=<toolsets dir>/, MODELS_DIR=<dir of the GGUFs>/)
# env: PW (playwright-core index.js)
H="$(cd "$(dirname "$0")" && pwd)"
port=$1; out=$2; shift 2
mkdir -p "$out"
for m in "$@"; do
  for l in en es de fr it pt zh ja ko ar ru hi vi th id pl; do
    f="$out/$m.$l.txt"
    grep -q "^SUMMARY" "$f" 2>/dev/null && continue
    node "$H/drive-page.mjs" "http://localhost:$port/tools.html?set=$l&runtime=webgl&format=gguf&model=$m" 20 > "$f" 2>&1
    echo "$m $l: $(grep -a '^SUMMARY' "$f" | sed 's/.*: mean/mean/; s/; same top.*//')"
  done
done
