# Checkers review follow-ups

Reviewed on current `checkers` base `332021e`, preserving the later defensive-prompt
changes after the reviewed `a02eea7` snapshot. No prompt, model, sampling, output limit,
thinking budget or outcome-version changes are part of this work.

| Finding | Fix | Verification |
|---|---|---|
| Lost game updates between tabs | Every mutation reads, validates and writes `games/current` in one native IndexedDB readwrite transaction. TanStack DB's public sync API publishes durable rows; it never writes a stale local full-row replacement. | Separate-connection IndexedDB regressions and independent Chrome frames: one conflicting opening move accepted, restart rejects late replies, opponent edits retain accepted moves, old-opponent replies rejected, reactive views converge. |
| Cancellation during cold Transformers.js grammar setup | Retain a request controller before the first await; register native stopping before grammar loading, check cancellation after async initialization, and dispose constraints in an encompassing finally. | Tests execute the real worker code with deferred grammar/model initialization: no prompt forward or model.generate call starts after stop; late constraints disposed; request/stopping entries cleared; request-id recovery works. |
| EOS aliases disagree | Explicit EOS proxies override both `eos_token_id` and `eosTokenId`, without mutating caller metadata. | Actual grammar accepts `null`, reports complete, permits only the overridden EOS, and correctly alternates overrides 257/256/257 over metadata initially set to 256. |
| Outcome analysis blocks rendering | Run prompt construction/search in an app worker; cancellation terminates its job. Healthy sequential jobs reuse an idle worker. Prior AI transcripts are omitted from the worker payload. Memoize board-only legality and history-aware runner responses per search. | All 44 pre-change annotations/full prompts match exactly, including the 39-suite positions, the reported 17-ply position, and four quiet-clock/repetition edge variants. Real Node worker parity and native Chrome UI/cancellation verified. |

## Storage contract

All game mutations, including ensure/restart, opponent updates, move commits and failure
logs, use the same synchronous reducer inside one native transaction. No Web Lock or
local collection value is used as the authority. Transaction aborts preserve the prior
row. A durable storage version lets reactive readers ignore duplicate notifications.
BroadcastChannel plus foreground refresh updates each tab from the authoritative row;
publication never performs another database put. One persisted game remains the contract.

Database version 2 preserves the existing game and closes version-1 connections through
the installed createIndexedDB versionchange handling, preventing older unconditional
writers from remaining active after upgrade. The native menu smoke check retained the
existing Resume game button. fake-indexeddb is a Checkers test-only dependency; no
third-party runtime source is patched.

## Analysis measurements and limits

The reproduced position has 11 AI choices. Node pre-change CPU diagnostics were roughly
294–297 ms; memoized CPU measurements are recorded alongside them and are not a controlled
throughput claim. The purpose of the worker is to remove that task from the UI thread.
Quiet-clock and repetition history remain part of every transition; only board-only
legality is shared without history. Runner-response cache keys include the full repetition
history and quiet clock. No search depth or capture settlement was shortened.

The saved native Chrome run reports exact prompt equality, no main-thread Long Tasks
during worker analysis, an advancing UI heartbeat, and successful cancellation. Its cold
elapsed time was 1140.5 ms and warm-worker samples were 917.2, 879.4 and 904.5 ms in that
dev-browser run. Abort completion measured 222.4 ms from scheduling a 25-ms timer; this
includes browser scheduling delay. These numbers are retained explicitly and are not
claimed to improve total turn latency. The idle-worker path avoids repeated module startup;
main-thread responsiveness is the verified improvement. No fresh model-quality run was
needed: the pre-existing suite's complete prompt strings and annotations are unchanged.

## Checks and reproduction

582 tests pass: Checkers 170, structured-output 105, Transformers.js 114 and WebGL 193.
Affected Nx tests, typechecks, lint and builds pass, as does the independent 39-case
Checkers audit and its static prerender build. Existing package lint warnings remain;
new Checkers code has no lint warnings.

```sh
NX_DAEMON=false NX_TUI=false NX_LOAD_DOT_ENV_FILES=false pnpm nx run-many -p checkers structured-output transformers-js webgl -t test typecheck lint build --outputStyle=static
NX_DAEMON=false NX_TUI=false NX_LOAD_DOT_ENV_FILES=false pnpm nx run checkers:bench-audit
```

For native reproduction under the development server, open `/bench/review-runtime.html`
in Chrome and use its two buttons. Storage checks run in independent iframe contexts
against a uniquely named disposable database; the saved game is untouched. The worker
check uses the exact recorded 17-ply fixture and compares its full prompt to the baseline.

Evidence: native storage (raw run archived locally),
native worker (raw run archived locally),
Chrome screenshot (raw run archived locally),
[44 frozen baseline records](../src/lib/__fixtures__/analysis-baseline.json.gz),
Nx package checks (raw run archived locally),
Nx Checkers checks (raw run archived locally),
source hashes (raw run archived locally).
