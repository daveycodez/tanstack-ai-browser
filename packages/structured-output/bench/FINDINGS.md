# Standard cache API cleanup and verification

The prompt-layout experiment is removed. Consumers keep their original messages,
tools, schemas, thread IDs, and standard TanStack `promptCache` arguments. No new
cache-placement options, consumer conditionals, schema reordering, or synthetic
user messages are required. WebGL and Transformers serialization is checked against
baseline commit `390c71a`; existing generation settings and cancellation behavior
are preserved.

## Changes

| Layer | Final behavior |
| --- | --- |
| WebGL engine/adapter | Verify exact token prefixes; protect an existing natural prefix checkpoint within the existing budget. Original prefill batch sizes and ordinary conversation anchors remain unchanged. Standard `none` clears managed prompt state before/after generation, including failures and cancellation. Weights remain loaded. |
| Transformers.js wrapper | Exact token-prefix matching and tokenizer-only fallback for templates requiring a user query; bounded prefix memo. Original prompt/checkpoint scheduling retained. Standard `none` skips managed memory/disk reads and writes and disposes run-owned state. |
| Prompt API adapter | Existing clean prefix bases/clones retained. Standard key/thread identity and `none` work in streaming and structured output; ephemeral sessions are destroyed. No invented TTLs. |
| Wllama adapter | Standard `none` maps internally to native `cache_prompt:false` and skips wrapper persistence. No new public provider cache knob. Other policies retain native defaults. |
| Apfel adapter | Normal stateless requests and exact schemas preserved. Standard options are accepted; native API exposes no verified cache key/retention control. No unsupported fields or invented cache-hit counts are sent. |
| Shared guided tools | Report actual provided cached-token counts. Required single-tool requests skip a forced routing decision and generate validated arguments directly; automatic/multiple-tool decisions remain unchanged. |

Key/retention support and cache hit counts remain provider-dependent, as with cloud
adapters. Local engines have one model worker, so a cache key need not create a
separate KV bucket. It never makes mismatching tokens reusable. Cached processing
does not reduce context-token consumption. No third-party runtime patch, sampling
change, output/context cap, or new TTL was introduced.

## Before/after browser timings

Apple M3 Ultra, macOS 27.2; IAB, with model defaults and thinking off. Milliseconds
below are median end-to-end latency after excluding each group's first call. Each
group has only 2 or 3 warm samples; small millisecond differences are not a guarantee
of a regression or gain. Cold/schema setup is retained separately in raw reports.
These are paired per-runtime comparisons, not model-versus-model rankings.

| Suite / workload | Before ms | After ms |
| --- | ---: | ---: |
| webgl-single / text | 126.5 | 127.4 |
| webgl-single / structured | 156.9 | 157.4 |
| webgl-tools / auto | 297.3 | 296.9 |
| webgl-tools / required | 345.1 | 170.3 |
| webgl-tools / named | 165.9 | 168.3 |
| tjs-single / text | 54.9 | 33.7 |
| tjs-single / structured | 80.0 | 78.7 |
| tjs-tools / auto | 85.2 | 84.9 |
| tjs-tools / required | 143.4 | 68.3 |
| tjs-tools / named | 46.3 | 50.3 |

Required single-tool latency fell about 50% in each runtime by removing a routing
call with only one possible outcome. Ordinary single prompts, automatic tools and
named tools retained their normal execution paths; no extra prefill passes were
added. The former schema-suffix slowdown is gone. Fixed-schema conversation prefill
was 54.9 → 57.7 ms on WebGL and 31.3 → 31.5 ms on Transformers; the earlier experimental
doubling is absent. Small measured differences remain visible in the raw results.

All 24 current tool cases, all 38 current conversation cases, and all 8 current
single structured requests passed. Strict free-text grading deliberately remains
unchanged: LFM3 emits `Paris</think>Paris` (and equivalent answers) in all four tiny
free-text cases in BOTH baseline and current runs. This is an existing formatting
issue, not repaired or hidden by this cache change. Transformers baseline answered
Italy incorrectly once; the current run passed all four text cases, so its text
speedup is not a controlled same-output decoding comparison. No quality gain is
claimed from that one sample. No new failed answers appeared in retained comparisons.

## Native checks

- Chrome Prompt API: 8/8 ordinary/structured calls and 8/8 `none` calls; all `none`
  reports have zero managed cached tokens. Guided tool and authoritative-result
  checks pass 2/2 using the single-tool path.
- Wllama: 4/4 calls through SDK `chat()`. `none` had zero reported cached tokens;
  `short` and `long` reused 32 tokens; `none` after the warm calls returned to zero.
- Apfel: 8/8 plain/structured calls. Native cache-hit metadata was absent and is not
  synthesized. This establishes compatibility, not native cache reuse/eviction.
- WebGL and Transformers: 4/4 structured `none` cases each, all with zero cached tokens.
- WebGL real GPU restoration: LFM3 and Qwen3.5 GGUF each restored 1,536 tokens.
  Cold/restored logits and separate same-batching copy controls were bit-identical
  in these fixtures (maximum absolute difference and KL divergence both zero).
  Existing snapshot limits remain 8 and 2. This is fixture/device evidence, not
  an assertion of bitwise equivalence for every possible prefill segmentation.

Native compatibility checks are not frozen old/new performance comparisons. Chrome
Prompt API's active model is browser-selected; no standardized identity is exposed.
All benchmark inputs are synthetic and no game storage is used.

## Automated verification

Nx test/typecheck/lint/build passed for all seven affected projects plus their
needed dependency: 503 tests (94 shared, 158 WebGL, 111 Transformers, 140 Checkers),
zero failures. Lint retains 48 existing WebGL warnings and the existing Transformers
`_token` warning; no lint errors. The retained GPU benchmark bundles successfully.
Preparation/cleanup was smoke-tested; generated app pages and all frozen baseline
copies were removed. See `results/nx-checks.log`, raw JSON and source/artifact hashes
in `results/manifest.json`.
