#!/bin/bash
# KL divergence / same-top / perplexity of a GGUF against saved reference logits, per corpus (llama-perplexity, Metal).
# usage: kleval.sh base <ref name> <ref.gguf>     save reference logits (BF16 -> "bf16", QAD as shipped -> "qad")
#        kleval.sh run  <ref name> <name> <gguf>  score a model against them; logs in $W/kl/<ref>/<name>/<corpus>.log
# env: BIN, W, G (old experiment dir: wt/wikitext-2-raw, q/chat-corpus.txt). Corpora in $W/text (prepdata.py, genchat.py).
set -euo pipefail
LANGS="en ar zh fr de it ja ko pt es vi th id hi ru pl"
NGL=${NGL:-99}
corpora() {  # name file chunks (0 = all); against BF16: all of WikiText-2 test and 60 chunks per Belebele language,
             # against the shipped QAD file (the head's own effect, a quicker screen): 60 and 20
  if [ "$1" = bf16 ]; then wc=0; bc=60; else wc=60; bc=20; fi
  echo "wiki $G/wt/wikitext-2-raw/wiki.test.raw $wc"
  echo "chat-en $G/q/chat-corpus.txt 0"
  for l in $LANGS; do echo "bele-$l $W/text/belebele/$l.txt $bc"; done
  for l in $LANGS; do echo "mlchat-$l $W/text/mlchat/$l.txt 0"; done
}
mode=$1; ref=$2
if [ $mode = base ]; then
  model=$3; mkdir -p "$W/kl/base-$ref"
  corpora $ref | while read c f n; do
    [ -f "$W/kl/base-$ref/$c.kld" ] && continue
    ch=(); [ "$n" != 0 ] && ch=(--chunks $n)
    "$BIN/llama-perplexity" -m "$model" -f "$f" -c 512 -b 2048 ${ch[@]+"${ch[@]}"} -ngl $NGL \
      --kl-divergence-base "$W/kl/base-$ref/$c.kld" > "$W/kl/base-$ref/$c.log" 2>&1
    echo "$ref $c $(grep -o 'Final estimate.*' "$W/kl/base-$ref/$c.log")"
  done
else
  name=$3; model=$4; out=$W/kl/$ref/$name; mkdir -p "$out"
  corpora $ref | while read c f n; do
    [ -f "$out/$c.log" ] && grep -aq "Mean    KLD" "$out/$c.log" && continue
    "$BIN/llama-perplexity" -m "$model" -c 512 -b 2048 -ngl $NGL --kl-divergence-base "$W/kl/base-$ref/$c.kld" --kl-divergence > "$out/$c.log" 2>&1 \
      || { echo "FAILED $ref $name $c"; tail -3 "$out/$c.log"; }
  done
fi
