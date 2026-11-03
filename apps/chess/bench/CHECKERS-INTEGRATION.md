# Checkers integration review — 2026-11-02

Current follow-up: Checkers through `62752c6` is merged, including the session-pool
fix. See [the latest cache verification](CACHE-VERIFICATION.md) for normal/disabled
cache controls, full-suite results and the GPU-contention timing limitation. Older
measurements and reproducer assertions below are historical evidence.

Reviewed and merged Checkers through **7c5f856**, including `390c71a`
(Prompt API structured session reuse), `3f3db14` (optional Apfel working notes),
and its Checkers gameplay, benchmark and audio changes. Merge: **6a76070**.
Chess's isolated temporary WebGL prefix-hint patch `591d559` was reverted in
**e20a5fb** before merging. All tracked `packages/` files now match Checkers.
Chess gameplay/prompt source is unchanged; shared-v19, seeded per-game move
presentation, every legal action, strict `{move}` schema and default reasoning
**off** remain in use. Native abort-controller propagation remains in place;
there is no `withCancellation` helper.

## What the library changes do

| Area | Reviewed behavior |
| --- | --- |
| Prompt API | Structured calls prepare/reuse a clean system/history base and generate on disposable clones. Answers and working notes never enter the base. Base preparation is serialized; clones can generate concurrently. Cache keys and chat/structured namespaces are separate. Changed options/history invalidate compatibility; stale clones recreate the base once before generation. Existing four-session pool and cancellation cleanup remain. |
| WebGL | Exact token-prefix matching, bounded tokenizer memoization, and protected prefix checkpoints at existing natural batch boundaries. Conversation anchors coexist within the existing snapshot count. No new prefill split or GPU kernel changes. New usage fields distinguish tokenization, schema setup, matched tokens and actual retained/restored points. |
| Transformers.js | Exact prefix matching, tokenizer-only A/B probes for templates requiring a user, and bounded memoization. Standard no-retention calls use/dispose run-owned KV without borrowing or saving managed memory/disk state. Existing checkpoint scheduling remains. |
| Wllama | Standard `promptCache: "none"` becomes native `cache_prompt:false` and skips wrapper state saves. Other policies preserve native behavior. |
| Shared guided tools | A required single tool proceeds directly to constrained arguments, removing the redundant routing model call. Automatic and multiple-tool selection remain. Usage sums actual reported cached tokens. |
| Apfel | Optional emulated reasoning adds a separate tool-free draft with caller/server output limits. Notes augment the current user turn without reordering tool results. Off stays single-pass. Cache support is not invented for the native API. |

The final upstream implementation does **not** move the schema after the system
prompt. It preserves existing schema/message serialization. Standard cache keys
are hints, not token-matching bypasses or guaranteed separate KV buckets. `short`
and `long` do not promise different local TTLs; no unsupported native controls
are fabricated.

## Issues and optimization opportunities

1. **Fixed a benchmark defect (2f84be3):** every trial formerly created a fresh
   game/thread ID. That prevented Prompt API session reuse even when testing a
   game's retries. The runner now shares a thread per run, or per repetition for
   New game mode, records that identity, and displays reported cache usage for
   both runtimes. No game storage is accessed and no new model-specific prompt
   is used. FEN, system/user text, complete choices and expected sets were asserted
   byte-equal across paired model reports.
2. **Short-prefix limitation confirmed:** changing Chess schemas share only
   238–319 tokens in this replay, before the first normal WebGL checkpoint.
   Actual changed-position reuse was **0/18,312 tokens**. The removed temporary
   patch reused 1,332/18,312 by explicitly splitting at 222 tokens. Keeping normal
   batches avoids its extra prefill segmentation, but relinquishes that reuse.
   Do not describe the upstream change as a changed-turn Chess cache speedup.
   An exact short-prefix checkpoint or schema-layout experiment needs separate
   latency and numerical/quality evidence before introduction; no padding,
   schema movement or custom cache hint was added here.
3. **Exact LFM3 retries remain effective:** all seven reused every input token
   (**18,312/18,312**); median prefill **9.9 ms**. Changed-position median prefill
   was **889.7 ms**. Previous temporary-patch replay medians were 12.9 and
   840.9 ms respectively, from another run. These are not controlled hardware
   performance deltas. Current changed turns also spent a median 16 ms in
   tokenization/prefix discovery. Dynamic schemas invalidate the system-prefix
   tokenization memo, an additional optimization target to measure.
4. **Nano reuse is system-prefix reuse:** 13/14 replay calls reused **212 tokens**
   each (2,756/36,504 aggregate). The last user board is supplied to a disposable
   working clone and must be processed again even on retries. This is intentional
   isolation, not full-board caching. Optional further reuse must preserve exact
   message/constraint semantics and avoid retaining generated answers.
5. **Confirmed idle-session pool bound issue:** six concurrent cold structured
   calls with distinct thread IDs leave **six idle base sessions** alive after all
   calls complete, despite `MAX_SESSIONS = 4`. In `sessions.ts`, insertion-time
   trimming skips busy entries and `lease.release()` only clears `busy`; it does
   not trim again. The shared pool code predates this merge; structured reuse now
   uses it too. Request a trim after bases become idle without destroying active
   leases or clones. The fake-native diagnostic below reproduces six retained
   bases, all disposable clones destroyed, and explicit cleanup still works.
   Its assertion intentionally confirms the current defect; the upstream
   regression should require at most four retained idle bases. No library patch
   was added here, so this can be fixed in Checkers and merged back.

   Reproduce from `packages/structured-output`:

   ```sh
   node --experimental-strip-types ../../apps/chess/bench/results/2026-11-02-prompt-pool-bound-repro.ts
   ```

6. **No new game-move correctness blocker found in this review.** Upstream
   retained GPU fixtures restored 1,536 tokens for LFM3 and Qwen3.5 with equal
   cold/restored logits and matched-batching copy controls, within existing
   snapshot budgets. Those archived native checks were reviewed, not rerun here
   on every runtime/device. Upstream also retains an existing unconstrained LFM3
   text-formatting failure (`Paris</think>Paris`) in both before/after runs. The
   strict Chess output path returned legal schema-conforming choices in every
   integration trial; that does not establish unconstrained-text correctness.

## Fresh Chrome verification

All calls used the same shared-v19 prompt, stable game move order, model defaults,
and **reasoning off**. Two repetitions each; saved player game untouched.

| Workload | LFM3 | Nano |
| --- | --- | --- |
| Seven reported gameplay regressions | **14/14 objectives**, 14/14 legal | **12/14 objectives**, 14/14 legal |
| Three held-out positions | **6/6 objectives**, 6/6 legal | **6/6 objectives**, 6/6 legal |
| Seven cache replay snapshots with retries | 14/14 legal, ungraded | 14/14 legal, ungraded |

**68/68 choices legal; zero browser warnings/errors captured.** Nano's two
misses were Qxe2+ (net −6 queen capture instead of safe Rxb8) and Bb4+ instead
of any of three free bishop captures on h6. These are actual tactical misses;
no prompt adjustment or quality improvement is claimed. This targeted sample is
not a full-suite regression analysis, Elo estimate or controlled before/after
cache-quality experiment. Active Prompt API model identity is browser-selected.

Nx test/typecheck/lint/build: **31/31 tasks succeeded** across Chess, Checkers,
WebGL, Transformers.js, Prompt API, shared structured output, Wllama and Apfel.
After the benchmark correction, Chess test/typecheck/lint/bench-check/bench-audit
and route generation passed **6/6**. Final production build passed separately.

Raw reports **92–97**, source hashes, input-parity assertions, failures and test
logs are in [the integration manifest](results/2026-11-02-checkers-integration-manifest.json).
Raw 92/93 retain a stale Vite-start revision and predate the tester identity fix;
the manifest records runtime merge 6a76070 explicitly. After refreshing Vite's
configuration, reports 94–97 record the actual source commit 2f84be3.
Historical cache results in [CACHE-FINDINGS.md](CACHE-FINDINGS.md) refer to the
removed temporary patch and remain preserved as evidence.
