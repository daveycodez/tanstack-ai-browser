# Checkers prompt compression: v7 → v8

Baseline is pushed `a5c2bb4`. This pass changes Checkers-authored instructions only.
The rules engine, outcome computation, cases, objective grades, accepted move sets,
legal-action schema, action order, five-turn history, model selection, recommended
sampling, output limits and reasoning budget are unchanged.

## Static system savings

Measured with the actual production LFM3 tokenizer, raw system-message content only.
Native adapter schema guidance and chat-template framing are excluded and unchanged.

| Section, top to bottom | v7 tokens | v8 tokens | Saved | Change |
|---|---:|---:|---:|---|
| Move policy | 127 | 113 | 14 | Shorter phrasing; retain every priority and exception, card independence, order neutrality, and necessary-retreat caveat. |
| American rules | 78 | 72 | 6 | Combine forward stepping/jumping and the crowned-king definition; retain direction, jump geometry/removal, compulsory chains, king vulnerability, and crown-stop rule. |
| Outcome heading | 8 | 4 | 4 | `HOW TO READ OUTCOMES:` → `OUTCOMES:`. |
| Outcome interpretation | 167 | 138 | 29 | Remove card-independence and retreat repeats already in policy; tighten horizon/minimax phrasing while retaining forced settlement, runner extension, bounded-preview caveat, and same-king safe-reply identity. |
| **Entire static system** | **380** | **327** | **53 (13.95%)** | No JSON/copy/stop-brace prose or padding. |

Rules and horizon explanations were retained even where the engine computes legal
moves already: they explain board/card meaning to the model. Removing those wholesale
would save more tokens with avoidable quality risk. More aggressive rule shorthand
and conditional explanations were not selected.

## Changing instruction savings

Definitions remain conditional, in the same fixed order before the board. The heading
is now `POSITION DEFINITIONS:` and the repeated `Definition of ` wrapper is omitted.
Nonlosing-exchange, free-capture, next-capture and quiet-progress descriptions are
shorter; the force-next-win and safe-crown explanations are unchanged. Every category
membership and every position-fact line after the cards remains byte-identical.

Across the unchanged 37-case suite, raw user-message text drops from **28,232 to
27,828 LFM3 tokens**: **404 saved**, or **10.92 per position**. These are additional
dynamic savings, not part of the 53 static-system tokens. BPE boundary effects mean
standalone string savings need not add perfectly to full-request counts.

The actual browser calls, including unchanged schema guidance and template framing,
save the following over 36 model-inferred cases per ordering (the forced case calls
no model):

| Model | Mean input saving per request | Median | Range |
|---|---:|---:|---:|
| LFM3 GGUF | 64.00 | 67 | 53–74 |
| Chrome Prompt API / Nano | 66.56 | 67 | 55–78 |

These are measured input-token reductions. Much of the static system is already
cached on repeated turns, so the 53-token reduction mainly helps uncached setup and
context usage. Warm-turn processing benefits primarily from the shorter changing
instructions; no guaranteed wall-clock speedup is claimed.

## Unchanged-suite Chrome comparison

Reasoning off, model-default sampling, same legal choice order for each before/after
pair. All 37 cases ran under both the existing paired permutation and production
per-game ordering, on both models: 296 completed trials, including eight forced
moves and 288 real model calls. All replies were legal; no new output errors.

| Model / ordering | v7 scored | v8 scored | Existing miss |
|---|---:|---:|---|
| LFM3 / paired | 26/27 | 26/27 | `recapture-compensation`, same in both |
| LFM3 / production | 27/27 | 27/27 | None |
| Nano / paired | 26/27 | 26/27 | `count-full-capture-chain`, same in both |
| Nano / production | 27/27 | 27/27 | None |

There is no scored case-level regression, not merely an equal aggregate score.
Production diagnostic signals also remain identical. LFM3's paired exchange signal
improved once. Nano's paired diagnostic choices changed on two intentionally
ungraded tradeoffs:

- Promotion-denial alternative: v7 chose `d8xf6` (checked +1, no Red crown); v8 chose
  `d8xb6xd4` (checked +2, allows a Red crown). The existing policy explicitly permits
  a better compensated exchange; neither the case nor its signal was regraded.
- Reported runner compensation: v7 chose `g1-f2` (checked net 0, next-capture pressure,
  reverses its previous move); v8 chose `h6-g5` (checked net 0, man advancement).
  Both allow two Red promotion replies. Production ordering picked the man move in
  both versions. This diagnostic does not establish a unique objectively best move.

These observations do not claim identical move choices or unchanged strength on
every unseen board. Existing historical holdouts were already seen, so this is
compatibility evidence, not a fresh unseen evaluation. No grades, accepted sets,
model temperatures, retries, outcome logic or schema constraints were adjusted to
make the result pass.

Median model decision times were essentially unchanged/noisy: LFM paired 0.518→0.512s,
production 0.527→0.532s; Nano paired 0.832→0.821s, production 0.824→0.826s. These small
single-run differences are not a controlled latency improvement.

## Preservation and verification

- Historical v6 remains byte-identical to 20 saved raw records; v7 remains identical
  to all 37 saved production inputs.
- v8 tests compare every legal card, board, history, horizon, position fact,
  conditional definition membership/order and outcome version to v7. Only audited
  instruction wording/wrappers differ.
- Wording tests explicitly preserve tactical priorities, safety exceptions,
  material minimax, the extra runner horizon, king identity and retreat caveats.
- **149 tests, typecheck, lint, production/prerender build and independent suite
  audit passed.** No model inference runs during automated checks.

Raw evidence: LFM comparison (raw run archived locally),
Nano comparison (raw run archived locally),
token counts (raw run archived locally),
summary (raw run archived locally),
source hashes (raw run archived locally),
Nx output (raw run archived locally),
Chrome proof (raw run archived locally).

The Vite startup revision in browser reports can predate HEAD. Exact prompt strings,
version labels, frozen baseline and source hashes identify the evaluated payloads.
Live gameplay stayed on v7 during evaluation and was promoted to v8 only afterward.

CPU-only reproduction, with locally downloaded production tokenizer files:

```sh
node apps/checkers/bench/measure-prompt.mjs /path/to/tokenizer.json /path/to/chat_template.jinja output.json
NX_DAEMON=false NX_TUI=false NX_LOAD_DOT_ENV_FILES=false pnpm nx run-many -p checkers -t test typecheck lint build bench-audit --outputStyle=static
```

For native reproduction, open `/bench` in Chrome, choose LFM3 or Prompt API, retain
production-order controls and click **Run quality comparison only**. v7 and v8 are
both selectable; v6 and the original baseline remain available. The runner uses the
same `chooseAiMove` path as gameplay and never changes the saved game.

## Final shared-constraint compatibility check

After the separate Qwen finite-string constraint guard was integrated, the same
v8 production-order LFM3 suite passed again: **27/27 scored, 37/37 legal**,
36 model calls and one forced move, median decision 0.525 seconds. Real short
prefix restoration remained present (359 matched tokens in the last trial).
This is a compatibility check, not a new before/after throughput comparison.
Raw report (raw run archived locally) and
Chrome result (raw run archived locally).

The separate constraint change also passed 401 tests across structured-output
(104), WebGL (185) and Transformers.js (112), with all 12 package
test/typecheck/lint/build targets passing. Qwen scope and limitations are
[documented separately](../../../packages/webgl/bench/review-followups/qwen-dead-end-findings.md).
