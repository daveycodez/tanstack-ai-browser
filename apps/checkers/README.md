# Checkers

A responsive, local-first checkers game built with TanStack Start and React. Play either color
against a local model through this monorepo's WebGL or Prompt API adapters and TanStack AI.
No hosted model or API key is needed.

## Run

From the monorepo root:

```sh
pnpm install
pnpm nx dev checkers
```

Open http://localhost:3002. If that port is occupied, choose another with
`pnpm nx dev checkers --port=3003` and use the URL Vite reports.

## Game and storage

The home menu offers **Start game** and, while a game is active, **Resume game**.
Starting over confirms before replacing the current game. `/game` restores the
current game or creates one when no saved game exists. There is only one saved game,
keyed as `current` in a TanStack DB IndexedDB Collection in the `checkers` database.
Each new game randomly assigns White or Black with equal probability; White always
moves first, so the opponent opens some games. Board, turn, move history, kings and
results survive reloads. Browser storage is
opened after hydration so both routes can render safely on the server.

American-style rules include compulsory captures, full multi-jumps, forward-only men,
short-range kings, promotion ending the turn, blocked-position wins, threefold draws,
and draws after 40 moves each without a capture or advancing an uncrowned piece.
Select one of your pieces, then a highlighted destination. Continue highlighted jumps to
complete a capture. Arrow keys navigate the board; Enter selects; Escape cancels selection.

## Motion and sound

Pieces travel across the board with a short lift and landing. Captures arc over the
opposing piece, which disappears as the jump lands; multi-jumps play one landing at
a time, including interactive human capture chains. Promotion crowns the piece after
landing. Board input and the next AI turn wait until playback settles, while game
state still saves immediately. Restarts/navigation cancel pending animation, restored
snapshots do not replay old turns, and reduced-motion preferences skip the arcs.

The speaker icon in the menu and game header toggles quiet move/capture taps and short
promotion/result cues. Sounds are synthesized locally with Web Audio; there are no
sound downloads. A shared document listener unlocks audio from trusted mouse, touch,
click, and keyboard gestures. Landing cues are scheduled ahead on the audio clock
when each animation starts, with cancelled moves cancelling their pending cues.
Unmuting plays a confirmation tap after audio resumes and may claim playback focus;
muting or hiding the page stops pending cues, releases that focus, and suspends audio.
The mute preference persists on this device and syncs between tabs. Unsupported or
blocked audio never prevents playing.

## Local opponent

The opponent label opens a model picker. It lists the WebGL models, excluding `-Web`
variants, and puts Prompt API first when the browser reports support. The selected model
and thinking setting are saved with the current game and carried into a new game.
Changing either cancels a pending turn and starts a reply with the new settings.

The default is `LiquidAI/LFM3-1.7B-GGUF`, thinking off. WebGL models use their own context limits; the game does not override context size.
Its first turn downloads about 1.1 GB; subsequent loads reuse the browser's model cache.
Other models download on first use. Download progress is labelled separately from cached
loading progress, in a fixed-height turn row. Prompt API uses the browser's built-in model.

The picker exposes Thinking for models that support it. Models with compulsory reasoning
show a checked, disabled control. Every WebGL turn requests `modelOptions.max_completion_tokens: 8192`.
With thinking enabled, every thinking-capable model also receives `reasoning: { level: "high", budgetTokens: 512 }`.
Prompt API exposes the same toggle through adapter-emulated working notes: an isolated
draft is streamed and measured against the 512-unit context-usage budget before a
native schema-constrained final response. This is a best-effort budget rather than
a native thinking-token cap; off uses the existing single-pass path.
There are no sampling overrides. The turn row
shows Processing during prompt prefill and Thinking during enabled reasoning. Clicking
Thinking opens the live model text in a scrollable modal that stays open after the move.
The browser needs WebGL 2, floating-point render targets, and OffscreenCanvas support.
Hardware-accelerated desktop and mobile browsers are the intended targets; actual
performance depends on the device.

`chat()` uses the selected model's supported reasoning mode and strict Zod structured output.
Each prompt includes the current
board and the last five moves from both players, oldest first. One shared prompt is used
for every model. Its descriptive action-label enum contains every legal complete turn;
the model chooses the label and the rules validate its exact existing move ID.
The current prompt provides the per-move analysis without recommended-action tags,
a preferred-move shortlist, or an instruction to follow one. When an action loses the game, or has a lower checked net
than another listed action, a final `SOUND CHOICES` line lists the other actions and the model
is told to choose from it; nothing ranks the listed actions, so that choice is the model's. The prior prompt remains available in the benchmark for comparison; lookahead
and legal choices are unchanged.
Move cards include captures, safe crowning, complete opponent jump chains, terminal
wins/draws, and a bounded reply/response material check (man 1, king 2). Quiet king cards
also show actual escape coverage and next-turn capture opportunities. These are factual
short-horizon observations, not a deep positional evaluation or an expert solver.
The WebGL adapter uses schema-constrained decoding; schema and rules validation happen
before a reply can alter the board. Invalid replies show a manual retry control without automatically calling the model again. There is no heuristic fallback. A 120-second generation deadline excludes model
loading. Leaving the route cancels the pending reply, and session/position guards reject
stale replies after a restart. Same-origin tabs serialize AI turns with Web Locks.
A failed turn stays blocked across tabs, busy-state changes, and reloads. An explicit
Retry click atomically acknowledges that failure and permits one new attempt; a
new failure blocks it again. Changing the opponent deliberately starts a fresh reply.

## Full turn log and manual benchmark

The bottom of `/game` lists every turn and provides **Copy log**. Its JSON reconstructs
before/after boards and retains actual AI prompts, move-card outcomes, chosen/raw answer,
model settings, timings, usage, optional reasoning, and failed attempts. Forced moves are
identified as having no model inference. Older saves are replayed when possible and
missing historical AI diagnostics stay explicitly unavailable. Logs remain on-device;
copying is an explicit user action. The full JSON report is built only when expanded
or copied, and its text is mounted only while expanded.

`/bench` is a separate manual benchmark page sharing the game's origin and model cache.
Inference runs only when **Run benchmark** is pressed. The original coordinate prompt is
retained as a before comparison. Both models use the same shared prompt and seeded
choice orders; no sampling settings are overridden. See [the benchmark guide](bench/README.md),
[the independent fixture audit](bench/SUITE-AUDIT.md), and [measured findings](bench/FINDINGS.md).

## Check and deploy

```sh
pnpm nx run-many -t test typecheck lint build -p checkers
pnpm nx preview checkers
pnpm nx run checkers:deploy-dry-run
pnpm nx deploy checkers
```

Preview serves the production build at http://localhost:3002; run the build first and
stop the dev server if it already uses that port. Deployment requires Cloudflare
authentication and builds the app before publishing the `checkers` Worker.

`vite.config.ts` enables prerendering, static route discovery and link crawling.
Builds generate `dist/client/index.html` and `dist/client/game/index.html`; a prerender
error fails the build. The game HTML contains a loading state until IndexedDB opens.
Unprerendered routes use the TanStack Start server in Cloudflare Workers.

`wrangler.jsonc` enables Node.js compatibility, logs and sampled traces. Its compatibility
date is the latest date supported by the workerd binary in the monorepo lockfile;
advance it with a runtime update. Static HTML uses URLs without trailing slashes.
The Cloudflare Vite plugin generates `dist/server/wrangler.json` and
`.wrangler/deploy/config.json`; Nx caches both the build and the deployment pointer.

See the [Cloudflare TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
and [TanStack prerendering guide](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering).
