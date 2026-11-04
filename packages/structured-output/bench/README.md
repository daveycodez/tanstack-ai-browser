# Adapter cache regression checks

Raw run artifacts are no longer tracked. Keep only [the latest compact summary](latest.json);
regenerate raw files locally as needed. Fixed regression fixtures remain separate.


These manual browser checks use the normal TanStack API. No consumer cache
placement controls or prompt-layout changes are used. The baseline is a frozen Git
revision of WebGL, Transformers.js, and their shared tool/constraint helpers.

From the workspace root, prepare pages on the existing Checkers Vite origin:

```sh
node packages/structured-output/bench/prepare-cache-qa.mjs apps/checkers 390c71a
```

The preparation refuses to overwrite existing files. Open these pages on the app's
existing dev server; inference starts only when Run is clicked:

- `/__single-prompts-qa.html`: independent plain-text and structured requests.
- `/__simple-tools-qa.html`: automatic, required, and named natural-language tool calls.
- `/__adapter-cache-qa.html`: short/long structured requests and growing conversations,
  including changing schemas. Changed prefix content must be processed again.
- `/__native-tools-qa.html`: native tool/context and standard cache-control checks.
- `/__prefix-numerics-qa.html`: WebGL cold/restored GPU logits and snapshot-copy controls.

Run Before then After with identical inputs and cache policy. The pages print JSON
with inputs, answers, correctness, usage, and latency. WebGL and Transformers have
frozen implementations; Prompt API, Wllama and Apfel runs are native compatibility
checks, not frozen before/after comparisons. Sampling, output allowance and context
use model/runtime defaults. Thinking is off. These pages do not touch saved games.

Pause source edits and Nx builds during browser runs to avoid development reloads.
Run models serially. Keep first-call timings separate from warmed requests, and
record machine load: GPU contention can change decode and prefill timings. Save all
results, including failures. The comparison utility verifies input equality before
reporting per-group medians (excluding each group's first request):

```sh
node packages/structured-output/bench/compare-cache-results.mjs before.json after.json
```

Consumers supply messages, tools, schemas, thread IDs and optional standard
`promptCache` settings. Adapters map supported hints; engines verify rendered token
prefixes and manage inference state. Native support and actual hit counts vary.
These checks do not assume that a cache hint guarantees a hit or that cached tokens
stop consuming context. No invented provider TTLs or unsupported native fields are
used. Native Apfel cache metadata is reported only when the server supplies it.

After saving reports, remove the generated pages and frozen copies before Nx lint:

```sh
node packages/structured-output/bench/prepare-cache-qa.mjs apps/checkers --clean
```

Do not commit generated app pages or frozen copies. No `.env` files are read, and
no inference runs during imports, automated tests, builds or prerendering.
