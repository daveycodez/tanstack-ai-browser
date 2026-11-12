# Manual chess AI benchmark

`/bench` is a TanStack Start route for explicitly requested browser model checks.
It uses the production `chooseAiMove()` path and never reads or writes the saved
game. Only explicitly pressing a **Run** button invokes a model. Tests, builds, prerendering
and CI do not run inference. Results and full JSON print in-page; nothing is
automatically downloaded.

Within one benchmark run, turns/retries share a game thread; New game mode separates
threads per repetition. Reports retain thread identity and provider-reported cache counts.

## Run

```sh
pnpm nx run chess:bench
```

Reuse the running Chess server when available and visit
[the benchmark](http://127.0.0.1:3003/bench), using Vite's reported port. The route
shares the game's origin and model cache. WebGL may download weights on first
use; Prompt API appears when the browser supports it. No hosted model API or key
is used.

## Mac parallel evaluation

On Mac desktops, **Run all three (Mac parallel)** runs Nano, LFM3 GGUF and Qwen GGUF
concurrently in this one tab. Development builds include Apfel as a fourth model
and label the button **Run all four (Mac parallel)**. All models receive the same positions, seeds and
prompt. Select a result card to inspect one model; **Full batch JSON** prints all
reports. **Stop** cancels every run and preserves completed trials. Phones remain serial.

The WebGL models use isolated in-page runtimes because each window's adapter has
one loaded-model slot. Prompt API stays in the main window. No inference starts
on runtime-route load, and no game storage is opened. Parallel timings are marked
diagnostic; measure latency separately with one model running. An isolated runtime that
fails to become ready may restart once before inference begins, recorded as
`config.runtimeRestarts: 1`. Model errors and completed decisions are never retried.

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
as `null`. These are different capabilities.

Every model receives the same **shared-v111-decoded-state-only** system and user assembly, standard
piece values and model-default sampling. Ownership is phrased as **you/opponent**;
**light/dark** identifies piece color for either assignment. The model receives complete
decoded piece lists and plain-language turn/castling/en-passant/clock metadata; full FEN remains in game/audit records.
See [the v98/v99 compaction comparison](PROMPT-COMPACTION.md) and [latest aggregates](latest.json) for native token counts, unchanged-suite scores, and serial timings.

The optional **WebGL temperature** control
is a manual sampling diagnostic; it leaves the shared prompt and ordinary gameplay
defaults unchanged. Native Prompt API retains browser sampling. There are no active profile, context,
queen-weight or per-model prompt switches. Guidance is phase-relevant: urgent
positions omit soft generic coaching; quiet positions receive applicable opening,
cover or king-coordination context. Actual promotion emergencies remain visible.

The strict **`{ move }`** schema enumerates a short SAN-based choice label for
**every legal move**, preserving presentation order. A `RISK -N` prefix exposes the worst
already-computed negative exchange net. Warned moves remain selectable;
there is no move filter or engine-picked replacement. Labels resolve exactly to UCI.
Each option retains its English description and raw SAN for audit. King-mobility facts
show legal destinations before and after the candidate move.  Ordinary play uses a stable per-game seeded presentation order;
a sole legal choice needs no generation.

## Suite and grading

The current **audited-v11-outcome-review** catalog contains **46 positions: 43 calibration and 3 held out**. It retains the original 39 local-objective/observation cases and adds seven recorded positions with complete frozen offline evaluations. At two repetitions this is 86 calibration decisions or 92 for the whole catalog. The seven cache-replay positions remain a separate control.

The objective counter is a **teaching signal**, not a general bad-move count. Its original accepted sets remain available for historical comparisons. A missed local objective can be a sound alternative; it is neutral until independent outcome evidence supports a clear mistake.

Independent outcome review accepts every winning mate regardless of mate distance, verified alternative mating continuations, moves within 200 cp of the strongest fixed-budget child, and different plans retaining at least +300 cp. Small differences outside those bands are **uncertain**, not failures. A 400-cp deterioration must also become substantially worse or lose a clear advantage before it is labeled a mistake. Already-losing positions, node/depth limits and bound scores remain diagnostic. Illegal moves, an avoidable next-turn mate and drawing instead of an available forced win are concrete rule failures. All reference data is post-run evaluation only and never enters model prompts.

Examples: all six verified defenses in the check-response fixture pass, while its seventh playable response is uncertain; nine different choices preserve the recorded promotion advantage. In a genuinely forced tactical position, only one move may qualify because the alternatives lose substantial material. No model is required to copy one preferred opening, move ID or shortest mating line.

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
- **Qd5+ is valid:** all six White evasions allow safe Qxh1, winning rook5. The
  checking move need not itself capture. See the independent forcing proof.
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
Expanding **Full report JSON** mounts `#benchmark-results-json` with the complete
report. Trial details also mount only while expanded. Current reports use
`schemaVersion: 4`, zero-based indices and `-1` for an invalid choice. Preserve
partial runs and operational failures as such.

Optional `usage` comes through TanStack AI's public `onUsage` middleware. It keeps
provider token counts and available reasoning-budget flags; missing values are
unknown. Character count cannot prove budget exhaustion.

**`revision` is a dev-server-start snapshot.** Vite captures it when the server
starts, so HMR can load later dirty source while the field still says
`05a0afb...-dirty`. Do not rewrite that raw field to a later commit. Identify the
actual experiment with `promptVersion`, output contract, complete recorded inputs,
and a locally saved source manifest. Restarting the server refreshes the startup
snapshot. Never edit runtime or test files during a model run. Historical reports
are not tracked; save any needed experiment data outside the repository.

## Static checks

```sh
pnpm nx run-many -t test typecheck lint bench-check bench-audit build -p chess
```

These checks do not invoke models. Model tests stay manual and outside CI. Do not
change grading to make a specific chosen move pass without an independent rules
proof. Preserve raw report schemas and values when deriving a corrected grade.

[Strategy research](STRATEGY-RESEARCH.md) distinguishes implemented facts from
proposals. The automated fixture audit independently validates the recorded positions.

## LFM cache replay

The separate **Game cache replay (7 turns)** preset uses seven valid snapshots
from the user's recorded opening. Use two repetitions with **Same game (stable
order)** for a position followed by an exact retry, and reload before the control
run with **Permuted stress test**. The fixed order seed makes inputs reproducible.
The page prints cached/input token totals and cache-hit calls; full usage retains
prefill and decoding timings. Cache inference is never automatic.

Ordinary play uses stable per-game presentation order and the adapter's default
cache policy. Exact retries preserve inputs; new positions change the user input.
Do not infer latency improvements from token reuse alone. Compare paired runs with
identical positions, model, thinking setting, order seeds and device load.

Development builds also list **Apple-FoundationModel** (Apfel on this Mac). Its
optional working notes are adapter-emulated, as labeled in reports. WebGL sampling
overrides do not apply to Apfel. Recorded fixtures explicitly assign the human
White so ordinary game-color assignment cannot change benchmark ownership.

## Production guidance

The default uses the tactical pipeline verified in the v111 experiments: bounded capture/recapture settlement, one additional opponent capture after local recapture, checked quiet forks, explicit immediate-mate action warnings, paired legal witness/net lines, compact worst-fork presentation and decoded metadata. The historical v98/v99 builders remain available for regression comparisons. The model still selects from every legal move; no safety veto, engine-selected substitute, analyst score or forced re-selection is used. Ordinary gameplay keeps reasoning off by default and the existing generation deadline.

The clean production implementation reproduced all 96 benchmark inputs and 33 head-to-head inputs from the validated v111 run exactly, including system text and choice cards. Prior experiments recorded a Stockfish Skill-0/depth-1 win in ten attempts (1 win, 7 losses, 2 unresolved caps), and a win as Black against a clean-context GPT-6.1 Sol High agent (33...Rc1#). These are bounded observations, not a general strength or win-rate claim. Rejected prompt variants and temporary match bridges are not part of this production patch.
