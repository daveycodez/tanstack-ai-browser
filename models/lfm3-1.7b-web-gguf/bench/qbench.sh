#!/bin/bash
# usage: qbench.sh <tag> <gguf basename> [runs]
# Opens the bench page in Firefox on an Android phone (adb reverse tcp:3008, 3009 and 3999) and appends
# every run line to qbench.jsonl. The relay (relay.py, port 3999) must log to $RELAY_LOG.
H="$(cd "$(dirname "$0")" && pwd)"
L=${RELAY_LOG:-$H/relay.log}; OUT=$H/qbench.jsonl
ADB=${ADB:-adb}; S=${ANDROID_SERIAL:?set ANDROID_SERIAL to the phone adb serial}
tag=$1; model=http://localhost:3009/$2; runs=${3:-2}
start=$(wc -l < $L)
$ADB -s $S shell am start -a android.intent.action.VIEW -d "'http://localhost:3008/?runs=$runs&chat=1&wasm=http://localhost:3009/relaxed.wasm&model=$model&n=$RANDOM$RANDOM'" org.mozilla.firefox >/dev/null 2>&1
for i in $(seq 1 600); do
  tail -n +$((start+1)) $L | grep -q '"done"' && break
  sleep 3
done
sleep 4
temp=$($ADB -s $S shell dumpsys battery | awk '/temperature/{print $2}')
tail -n +$((start+1)) $L | grep '"run"' | python3 -I -c "
import json,sys
for l in sys.stdin:
    d=json.loads(l[l.index('{'):]); c=d.get('chat') or {}
    rec={'tag':'$tag','file':'$2','run':d.get('run'),'cachedBefore':d.get('cachedBefore'),'read':c.get('readTokS'),'write':c.get('writeTokS'),'first':c.get('firstTokenS'),'prompt_n':c.get('prompt_n'),'loadMs':d.get('loadMs'),'battTemp':$temp,'error':d.get('error')}
    print(json.dumps(rec)); open('$OUT','a').write(json.dumps(rec)+'\n')
"
