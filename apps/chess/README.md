# Chess

A responsive blue-and-silver chess game built with TanStack Start, React, TanStack DB,
and this workspace’s local Prompt API and WebGL adapters. Human plays White; the
selected language model plays Black. No hosted inference or API key is required.

## Run

```sh
pnpm install
pnpm nx dev chess
```

Open the URL Vite reports, normally http://127.0.0.1:3003. Checkers remains a separate
project at port 3002. Reuse an existing Chess server when one is already running.

## Playing, appearance, and feedback

Select a white piece and a highlighted destination. Arrow keys move focus, Enter or
Space selects, and Escape clears selection. Promotion offers all four pieces. The
board can be flipped. Chess.js validates check, mate, stalemate, castling, en passant,
underpromotion, repetition, fifty-move draws, and insufficient material.

The home screen’s top-right theme dropdown offers System, Light, and Dark. System
is the default; the choice persists separately from the saved game. Movement and
capture animations also cover castling rooks, en passant, and promotions. Reduced
motion is respected; animation never postpones the logical move or the AI’s turn.

The speaker control on the menu and game persists its mute preference. Move,
capture, check, checkmate, promotion, castling, and draw cues are synthesized locally;
there are no sound-asset downloads. Audio starts only after a user gesture. Enabling
sound explicitly plays a test tap and requests playback audio when supported.

TanStack DB’s IndexedDB collection stores the board, starting/current FEN, complete
move history, result, and opponent in the separate `chess` database. Replaying the
history preserves repetition rights. Storage opens after hydration. Starting over
asks before replacing an active game. Theme and sound preferences use local storage.

## Local AI

The opponent picker lists WebGL models and an available browser Prompt API model.
WebGL weights download on first use and cache in the browser. Loading, processing,
optional thinking, and errors are visible. The game never silently uses a cloud AI.

Every model receives the same system instruction and user prompt. The user prompt
contains the decoded current pieces and squares, side/check status, available
castles, the last eight individual moves, and every legal move with concise outcome
facts. FEN, full history, castling rights, en passant, and counters remain authoritative
inside the rules engine; the model does not have to decode FEN.

The active **shared-v18** prompt makes context relevant to the position. Tactical
positions retain concrete dangers and opportunities without generic opening or
endgame coaching. Quiet positions receive early-development advice, actual
pawn-cover context, or simplified king-coordination facts when relevant.

Annotations cover captures, check/mate/draw, legal recapturers, immediate mating
replies, protection, castling rights, actual promotion replies and legal opponent
king destinations. Promotion facts distinguish unanswered losses from legal
recaptures or compensation. Zero king destinations alone is not mate. Conditional
material accounting covers our move, an opposing capture, and the best immediate
legal recapture; it is not a deeper ranking or a forced sequence. Values remain
pawn 1, knight/bishop 3, rook 5, queen 9; kings are royal.

All legal choices remain selectable in a strict `{ move }` enum. The exact selected
label maps back to its existing UCI ID and is checked again for legality. No loose
parsing, random replacement, or search-engine move selector substitutes an answer.
Ordinary turns shuffle presentation order; a sole legal move needs no generation.

Thinking defaults to off. Supported models expose an optional toggle with a
512-token on-mode budget; the manual tester also offers 1,024 or uncapped thinking
for diagnosis. Uncapped omits the separate reasoning-token ceiling; normal runtime
context, output, and deadline limits still apply. The
shared game instructions do not require reasoning. LFM uses native thinking;
Prompt API’s optional working notes are explicitly an adapter-managed extra pass.

WebGL uses the model’s actual configured token context. `maxTokens: 8192` is a
generation ceiling, not the context setting. The arbitrary character-count guard
has been removed. Prompt API manages its native final-output limit.

Leaving, restarting, changing models, or changing position cancels an in-flight turn.
Persisted session/position/opponent checks reject stale replies, and Web Locks
serialize same-origin turns. A 120-second generation deadline starts after loading;
errors offer a manual retry. Adapters receive TanStack AI’s native abort controller.

## Verify

```sh
pnpm nx run-many -t test typecheck lint build -p chess
pnpm nx run chess:bench-check
pnpm nx run chess:bench-audit
```

These checks do not load or invoke models. The production build prerenders the
routes and uses the separate `chess` Cloudflare Worker configuration. No deployment
is required to play locally.

## Manual model benchmarks

Run `pnpm nx bench chess`, or reuse the running server and visit `/bench`. This is a
normal TanStack Start route, isolated from saved-game storage. Only pressing Run
invokes a model. Results and full JSON print in-page; reports are never downloaded.

There is one shared prompt and one output contract for all models. The audited suite
has **39 positions: 36 calibration and 3 held out**, with **21 scored objectives
and 18 neutral diagnostics**. An Observed games preset isolates the seven replayable real-game cases.
The suite accepts intelligent alternatives, including a forcing pawn check before
winning a knight and valid defenses against promotion.

See [benchmark instructions](bench/README.md), [suite audit](bench/SUITE-AUDIT.md),
[findings and historical grading corrections](bench/FINDINGS.md),
[reasoning audit](bench/REASONING-AUDIT.md), and
[strategy research and implementation status](bench/STRATEGY-RESEARCH.md).

Desktop/mobile theme and layout checks passed. The user confirmed hearing the
in-game sounds on an iPhone after the gesture/playback fix. Current evaluation
results and their limits are documented in the findings; this is a casual local
opponent, not a claimed professional-strength chess engine.
