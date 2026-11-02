#!/bin/bash
# Tool scores of one GGUF on llama.cpp CPU (-ngl 0): starts llama-server, runs toolscore.py on every prompt set, stops it.
# usage: runtools.sh <name> <gguf> <port> [lang ...]     output: $W/${TOOLDIR:-tools}/<name>.json
# env: BIN, PY, W (sets in $W/toolsets from mltools.py), THREADS (default 8)
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
name=$1; model=$2; port=$3; shift 3
mkdir -p "$W/${TOOLDIR:-tools}" "$W/logs"
[ -f "$W/${TOOLDIR:-tools}/$name.json" ] && exit 0
"$BIN/llama-server" -m "$model" --port $port -c 4096 -np 1 -ngl 0 -t ${THREADS:-8} > "$W/logs/srv-$name.log" 2>&1 &
pid=$!
trap "kill $pid 2>/dev/null" EXIT
for i in $(seq 120); do
  curl -s localhost:$port/health | grep -q ok && break
  kill -0 $pid 2>/dev/null || { echo "server for $name died"; tail -5 "$W/logs/srv-$name.log"; exit 1; }
  sleep 1
done
"$PY" -I "$H/toolscore.py" $port "$W/toolsets" "$W/${TOOLDIR:-tools}/$name.json.tmp" "$@" > "$W/logs/${TOOLDIR:-tools}-$name.txt"
mv "$W/${TOOLDIR:-tools}/$name.json.tmp" "$W/${TOOLDIR:-tools}/$name.json"
echo "$name: $(grep '^en:' "$W/logs/${TOOLDIR:-tools}-$name.txt")"
