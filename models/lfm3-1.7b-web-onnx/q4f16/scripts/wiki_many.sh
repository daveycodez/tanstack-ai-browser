#!/bin/bash
# usage: wiki_many.sh label=path ...   (runs 4 at a time)
cd "$(dirname "$0")/.."
run() { venv/bin/python -I scripts/wikippl.py dl dl/wikitext/wikitext-2-raw-v1/test-00000-of-00001.parquet out/wiki_ref.npy "${1%%=*}" "${1#*=}" 16 2>&1 | grep '^{'; }
i=0
for a in "$@"; do run "$a" & i=$((i+1)); if [ $((i % 4)) -eq 0 ]; then wait; fi; done; wait
