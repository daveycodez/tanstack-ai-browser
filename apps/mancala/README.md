# Mancala

A Kalah Mancala game built with TanStack Start, React, TanStack DB and IndexedDB,
following the Checkers and Chess apps. Custom CSS supplies a sea-glass board,
gold and green seeds, and light/dark/system themes. No component framework is
required. Cloudflare hosts the production app.

```sh
pnpm install --frozen-lockfile --filter '@tanstack-ai-browser/mancala...'
pnpm nx run mancala:dev
```

The default address is http://127.0.0.1:3004. Routes:

- `/`: menu and saved-game resume.
- `/game`: six-pit, four-seed Kalah; capture opposite seeds, earn extra turns,
  sweep remaining seeds when either row empties, and compare final stores.
- `/bench`: local model practice board and exportable diagnostics.

The board is horizontal on desktop and turns vertically on phones (480px and
below), with your pits on the right and your store at the top. Seed flights,
progressive sowing, capture feedback, and procedural Web Audio cues respond to
each move. Reduced-motion preferences skip playback. Muting cancels scheduled
sounds; audio activation and page visibility follow the other games' lifecycle.

## Local AI

The model catalog, default LFM3 opponent, reasoning controls, Prompt API
availability and development-only Apple opponent match Checkers. Models are
loaded only for an AI turn or an explicitly started benchmark; there is no cloud
inference or heuristic replacement of an invalid model answer.

`shared-prompt.ts` uses versioned system instructions and computed outcomes for
every legal pit. A worker checks six sowing actions per alternative, keeps the
same player during extra turns, accounts for captures and final sweeps, and
reports bounded minimax store margins and immediate human threats. Search
estimates are distinguished from secured-majority or proved terminal results.
Every legal pit remains available in the strict output schema. Per-game order
shuffling and paired benchmark orders expose first-option bias.

The Prompt API requires a supporting browser; WebGL models require the existing
WebGL runtime's browser/GPU capabilities. Model downloads can be substantial.
See [bench/README.md](bench/README.md) for scoring limits and repeatable runs.
Automated tests verify the rules, context, worker, runner, persistence and audio;
they do not establish model strength. No measured LLM benchmark scores are
checked in.

## Storage and build

The `mancala` IndexedDB database is separate from other games. A TanStack DB
collection publishes the durable current game; all mutations first re-read and
validate the session, move count and expected opponent inside one native
IndexedDB transaction. BroadcastChannel and focus refresh keep tabs in sync.
Web Locks serialize AI turns across tabs. An interrupted game resumes from the
committed position; transient animations never become authoritative state.

```sh
pnpm nx run mancala:test
pnpm nx run mancala:typecheck
pnpm nx run mancala:lint
pnpm nx run mancala:bench-audit
pnpm nx run mancala:build
```

Test and typecheck targets build their workspace package dependencies. The Vite
configuration enables TanStack Start static pre-rendering with link crawling and
failure-on-error. The production build emits HTML for `/`, `/game`, and `/bench`,
plus the Cloudflare Worker bundle. Browser storage opens only after hydration;
no inference or model downloads run while pre-rendering.

`pnpm nx run mancala:deploy-dry-run` checks Cloudflare packaging without publishing.
`pnpm nx run mancala:deploy` publishes when deployment is intended.
