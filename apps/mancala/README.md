# Mancala

A Kalah game built with TanStack Start, React, TanStack DB and IndexedDB, following
the Chess and Checkers apps. Custom sea-glass styling, animated gold/green seeds,
procedural Web Audio, light/dark/system themes, and responsive desktop/mobile
layouts require no component framework. The build is configured for Cloudflare.

```sh
pnpm install --frozen-lockfile --filter '@tanstack-ai-browser/mancala...'
pnpm nx run mancala:dev
```

The default address is <http://127.0.0.1:3004>:

- `/`: menu and saved-game resume.
- `/game`: six pits per side, four starting seeds each; captures, bonus turns and
  a final sweep. New game / Play again lets either player start.
- `/bench`: local model practice board; see [benchmark instructions](bench/README.md).
- `/bench-runtime`: isolated same-origin runtime for explicitly started parallel
  benchmarks. Loading it never starts inference.

The board is horizontal on desktop and vertical at phone widths (480px or below).
On phones, your pits are on the right and your store is at the top. Reduced-motion
preferences skip seed-flight playback; muting cancels scheduled sound effects.
The whole selected handful travels together from pit to pit, dropping one seed
at each stop. Captures and final sweeps animate every transferred seed into its
store along low, smoothly eased paths with staggered arrivals.

## Local AI

The model dropdown, default LFM3 opponent and reasoning controls match Checkers.
Models load only for an AI turn or an explicitly started benchmark. Prompt API
requires a supporting browser; WebGL models require compatible browser/GPU
features. There is no cloud inference or silent replacement of an invalid model
answer with an engine choice.

Current `shared-v16` lists every legal move and its outcomes without selecting an
action for the model. It removes recommended/preferred lists, BEST/OTHER markers,
relative-to-best ranking fields and instructions to copy an engine recommendation.
The model compares each move's outcomes itself; labels, order, lookahead, exact
proofs, legal schema, sampling and generation settings are preserved from v15.

The shared, model-agnostic analysis includes:

- Four-complete-turn analysis includes every bonus sow, capture and final sweep.
  If the resource limit is reached, all alternatives use a shared lower horizon;
  incomplete values cannot create a safe or preferred-action claim.
- Capture exposure includes Human bonus chains and names the endangered AI pit.
  A possible steal is distinguished from a forced net loss.
- Unresolved ties can receive a deeper common-horizon review. Eligible endgames
  receive bounded exact final-margin comparisons.
- An additional <=24-pit-seed proof can establish win/draw/loss with a shared
  one-million-visit cap and a 75,000-entry table. Completed proofs refine the listed
  per-action outcomes; incomplete searches are discarded.
  Outcome-only proofs do not invent exact final seed totals.

Analysis runs in a cancellable worker. Equivalent endgame searches share a
four-entry result memo within one prompt build, including deterministic exhausted
results. Eligibility is checked before reuse; positions, ordered actions and
resource limits must match. Results retain their original logical visit counts
for report compatibility, and no cache survives the request.
The separate phases have their own budgets; the outcome-proof cap is not a cap
on the entire turn. Every legal label remains
available to the language model, whose actual answer selects the move. Historical
prompt versions remain source-selectable for A/B comparisons.

Under the historical v15 prompt, all three models measured 40/40 scored trials and 46/46 legal responses
on the 23-position suite, with thinking off. Three positions are deliberately
ungraded diagnostics. [Compact results](bench/RESULTS.md) also retain the two genuine
win-to-loss regressions and the twelve-game equal-guidance starter breakdown.
These historical measurements do not establish v16 quality or general playing strength. Full historical captures stay local and are not committed as test data.

## Storage and build

The `mancala` IndexedDB database is separate from the other games. A TanStack DB
collection publishes durable state. Each write re-reads and validates the session,
move count and expected opponent in one IndexedDB transaction. BroadcastChannel,
visibility and focus refresh keep tabs synchronized; Web Locks serialize AI turns.
A new session preserves the chosen opponent and rejects late replies for an old
session, including when the AI starts. Animation frames are never authoritative.

```sh
pnpm nx run mancala:test
pnpm nx run mancala:typecheck
pnpm nx run mancala:lint
pnpm nx run mancala:bench-audit
pnpm nx run mancala:build
```

The Vite configuration enables TanStack Start static pre-rendering with link
crawling and failure-on-error. Production emits HTML for `/`, `/game`, and `/bench`
plus the Cloudflare Worker bundle. Storage opens only after hydration; builds
never run inference or download models.

`pnpm nx run mancala:deploy-dry-run` checks packaging without publishing.
`pnpm nx run mancala:deploy` publishes when intended.
