# Manual chess AI benchmark

Current prompt audit: [Chess-only concision findings](PROMPT-CONCISION-AUDIT.md). The retained prompt saves about191–192 input tokens/turn
without changing the main models' matched tactical grades. More aggressive cuts
were tested and rejected. No shared packages were modified.

Current follow-up: Checkers through `62752c6` is merged, including the session-pool
fix. See [the latest cache verification](CACHE-VERIFICATION.md) for normal/disabled
cache controls, full-suite results and the GPU-contention timing limitation. Older
measurements and reproducer assertions below are historical evidence.

`/bench` is a TanStack Start route for explicitly requested browser model checks.
It uses the production `chooseAiMove()` path and never reads or writes the saved
game. Only pressing **Run benchmark** invokes a model. Tests, builds, prerendering
and CI do not run inference. Results and full JSON print in-page; nothing is
automatically downloaded.

See [the Checkers integration review](CHECKERS-INTEGRATION.md) for current adapter
behavior, cache limitations and both-model verification. Within one benchmark run,
turns/retries share a game thread; New game mode separates threads per repetition.
Reports retain the thread identity and actual provider-reported cache counts.

## Run

```sh
pnpm nx run chess:bench
```

Reuse the running Chess server when available and visit
[the benchmark](http://127.0.0.1:3003/bench), using Vite's reported port. The route
shares the game's origin and model cache. WebGL may download weights on first
use; Prompt API appears when the browser supports it. No hosted model API or key
is used.

## Controls and request contract

Choose a model, 1–20 repetitions per position (default 2), and a position preset.
Calibration is the default; all positions, holdouts, seven observed games, and
individual cases are explicit choices. **Stop** aborts the operation and preserves
completed rows as a partial report. Controls stay disabled during a run.

Optional reasoning defaults off. Native reasoning is used where supported;
Prompt API labels its separate emulated pass **Working notes**. The normal enabled
budget is 512 tokens, with 1,024 and **Uncapped thinking** available for diagnosis.
Uncapped records `reasoningBudgetTokens: null` and omits `budgetTokens` from the
request; it does not remove runtime context, generation, or deadline limits.
WebGL's total generation
ceiling is 8,192 tokens; Prompt API's browser-managed final-output limit is recorded
as `null`. These are different capabilities. See [the reasoning audit](REASONING-AUDIT.md).

Every model receives the same **shared-v22** system and user assembly, standard
piece values and model-default sampling. There are no active profile, context,
queen-weight or per-model prompt switches. Guidance is phase-relevant: urgent
positions omit soft generic coaching; quiet positions receive applicable opening,
cover or king-coordination context. Actual promotion emergencies remain visible.

The strict **`{ move }`** schema enumerates the exact readable action label of
**every legal move**, preserving presentation order. Labels resolve exactly to UCI;
SAN and UCI remain in the audit data. There is no loose parsing, engine-picked
replacement, ranked shortlist or legal-move filter. Ordinary play uses a stable per-game seeded presentation order;
a sole legal choice needs no generation.

## Suite and grading

The current **audited-v9** suite contains **39 positions: 36 calibration and 3 held
out**, with **21 scored objectives and 18 neutral diagnostics**. Calibration has
18 scored positions and 18 diagnostics. At the default two repetitions this is
72 calibration trials or 78 trials for the complete suite. Four-repetition
calibration runs contain 144 trials and 72 scored decisions.

Use calibration for prompt selection. Freeze source before holdouts. If held-out
results influence another change, those positions have become calibration data;
confirmation needs fresh positions. [The independent audit](SUITE-AUDIT.md) uses
fresh chess.js positions rather than trusting model annotations. A pass means the
declared short-term objective was met; it is not an engine-best or Elo judgment.

Seven replayed games cover an exposed knight/rook threat, a free bishop after
17.Bxb8, the continuation after 25.Nxf5, promotion defense after 72.h7, the phone
queen drop at 18...Qxf1+, the bishop after 3.Ba6, and the bishop after 3.Bxh6.
All equally valid ties and independently proven alternatives remain accepted.

Important corrections:

- **Qxf2+ is valid:** after each of the three legal king evasions, Qxf5 safely
  follows, gaining 4 in total versus the direct knight capture's 3.
- **H7 has ten valid defenses:** Qxh7+ is a separate capture signal. Retaining
  an answer to promotion can also satisfy the objective. Qh8 from h4 is blocked
  by the h7 pawn and remains illegal.
- **Qxa4 can be correct:** after 17...a4 18.bxa4, saving the attacked queen differs
  from the earlier free-bishop opportunity. Defended queen exchanges can also
  be materially sound.

Neutral signals—castling, pawn cover, protection, opening a line or reducing king
destinations—are not tactical grades. Support is not capture immunity. Castling
with thinner cover is legal when the rules permit it; cover counts are not a
material score or automatic ban. Zero king destinations does not establish mate
when other replies remain. Strategic preference signals do not prove improved
winning technique.

Each trial records FEN, optional history, objective, accepted moves and complete
ordered choices. **Same game (stable order)** reuses the order seed for every
repetition. **New game per repetition** derives a distinct seed per repetition.
**Permuted stress test** replays recorded pairs, then reproducible permutations.
These change presentation, not the shared chess instructions. Sampling remains the
model's default. A first-option count describes this sample; it does not by itself
prove causal index bias or chess strength.

## Reports and source provenance

Expandable details retain the exact system/user input, ordered facts, raw answer,
resolved UCI, choice index, legal result, grade, latency, notes and errors.
`#benchmark-results-json` contains the full report. Current reports use
`schemaVersion: 4`, zero-based indices and `-1` for an invalid choice. Preserve
partial runs and operational failures as such.

Optional `usage` comes through TanStack AI's public `onUsage` middleware. It keeps
provider token counts and available reasoning-budget flags; missing values are
unknown. Character count cannot prove budget exhaustion. See [REASONING-AUDIT.md](REASONING-AUDIT.md).

**`revision` is a dev-server-start snapshot.** Vite captures it when the server
starts, so HMR can load later dirty source while the field still says
`05a0afb...-dirty`. Do not rewrite that raw field to a later commit. Identify the
actual experiment with `promptVersion`, output contract, complete recorded inputs,
and the corresponding source manifest. The [V19 cache comparison](results/2026-11-02-v19-cache-comparison.json)
records the current frozen source; the [V18 manifest](results/2026-11-02-shared-v18-source-manifest.json)
preserves the earlier checkpoint separately. Restarting the server refreshes
the startup snapshot. Never edit runtime or test files during a model run.

## Static checks

```sh
pnpm nx run-many -t test typecheck lint bench-check bench-audit build -p chess
```

These checks do not invoke models. Model tests stay manual and outside CI. Do not
change grading to make a specific chosen move pass without an independent rules
proof. Preserve raw report schemas and values when deriving a corrected grade.

[Findings](FINDINGS.md) records completed evaluations and pending work.
[Strategy research](STRATEGY-RESEARCH.md) distinguishes implemented facts from
proposals. The numbered [raw reports](results/) remain historical evidence; old
profiles and prompt/schema descriptions are not current controls. The
[retrospective audit](results/2026-11-02-audited-v6-retrospective.json) regrades only
matching case IDs and exact FENs, retaining original grades and legality failures.

## LFM cache replay

The separate **Game cache replay (7 turns)** preset uses seven valid snapshots
from the user's recorded opening. Use two repetitions with **Same game (stable
order)** for a position followed by an exact retry, and reload before the control
run with **Permuted stress test**. The fixed order seed makes inputs reproducible.
The page prints cached/input token totals and cache-hit calls; full usage retains
prefill and decoding timings. Cache inference is never automatic.

See [cache and ordering findings](CACHE-FINDINGS.md) for the final per-game policy,
opening variety, raw reports 84–91 and the temporary WebGL patch awaiting Checkers
integration. The original 39-case tactical inventory is unchanged; the independent
audit additionally validates the seven neutral replay fixtures.

For a separate model-free check of move facts and serialization preservation:

```sh
pnpm nx run chess:bench-concision-audit
```

It never calls an LLM and is independent of the regular test target.
